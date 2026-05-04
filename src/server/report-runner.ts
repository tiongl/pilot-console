/**
 * Report runner — orchestrates a single report execution:
 * 1. Create a run record
 * 2. Spawn a one-shot daemon session with the prompt
 * 3. Capture output and invoke the renderer
 * 4. Store result, send notification, prune old runs
 */

import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getDaemonClient } from '../daemon/client';
import { render } from './renderers';
import {
  createRun,
  completeRun,
  pruneOldRuns,
  updateRunDaemonSession,
  cleanupStaleRuns,
  type ReportSchedule,
} from '../shared/schedule-store';
import { broadcastReportReady } from './websocket';
import { normalizePtyOutput } from '../shared/strip-ansi';

const IS_WINDOWS = process.platform === 'win32';
const SHELL = IS_WINDOWS
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');
const CLI_COMMAND = process.env.COPILOT_CLI_COMMAND ?? 'gh';
const CLI_ARGS = (process.env.COPILOT_CLI_ARGS ?? 'copilot').split(' ').filter(Boolean);

/** Directory where report files are saved */
const REPORTS_DIR = path.join(os.homedir(), '.pilot-console', 'reports');

/** Pre-accept WorkIQ EULA so non-interactive CLI runs don't get blocked */
function ensureWorkIqEula(): void {
  const workiqDir = path.join(os.homedir(), '.work-iq-cli');
  const workiqFile = path.join(workiqDir, '.workiq.json');
  if (fs.existsSync(workiqFile)) return;

  try {
    fs.mkdirSync(workiqDir, { recursive: true });
    fs.writeFileSync(workiqFile, JSON.stringify({
      'I-accept-EULA': 'true',
    }, null, 2), 'utf-8');
    console.log('[report-runner] Pre-accepted WorkIQ EULA');
  } catch (err) {
    console.warn('[report-runner] Failed to pre-accept WorkIQ EULA:', err);
  }
}

/** File extension for each renderer type */
const RENDERER_EXT: Record<string, string> = {
  markdown: 'md',
  json: 'json',
  html: 'html',
  plaintext: 'txt',
};

/** Get the file path for a given run ID and renderer type */
export function getReportFilePath(runId: string, rendererType: string): string {
  const ext = RENDERER_EXT[rendererType] ?? 'txt';
  return path.join(REPORTS_DIR, `${runId}.${ext}`);
}

/**
 * Wrap the user's prompt with instructions to save the report to a file,
 * and formatting guidance based on renderer type.
 */
function buildReportPrompt(
  userPrompt: string,
  rendererType: string,
  reportFilePath: string,
): string {
  const formatHints: Record<string, string> = {
    markdown: 'Format the report as clean Markdown. Use headers, lists, and tables where appropriate.',
    json: 'Format the report as valid JSON only — no surrounding prose, no code fences.',
    html: 'Format the report as valid HTML. All links must open in a new tab with noopener noreferrer.',
    plaintext: 'Format the report as plain text.',
  };
  const hint = formatHints[rendererType] ?? formatHints.plaintext;
  const filePath = reportFilePath.replace(/\\/g, '/');

  return `${userPrompt}\n\n${hint} Then write the response to ${filePath}`;
}

/** Map of runId → { daemonSessionId, outputSoFar } for currently running reports */
const runningReports = new Map<string, { daemonSessionId: string; output: string; scheduleId: string }>();

// On server start, mark any stale running/pending runs as failed
const staleCount = cleanupStaleRuns();
if (staleCount > 0) {
  console.log(`[report-runner] Cleaned up ${staleCount} stale run(s) from previous server session`);
}

/** Get live output for a running report */
export function getRunningReportOutput(runId: string): { output: string; daemonSessionId: string } | null {
  const entry = runningReports.get(runId);
  return entry ? { output: entry.output, daemonSessionId: entry.daemonSessionId } : null;
}

/** Get all currently running report IDs for a schedule */
export function getRunningReportForSchedule(scheduleId: string): string | null {
  for (const [runId, entry] of runningReports) {
    if (entry.scheduleId === scheduleId) return runId;
  }
  return null;
}

/** Kill a running report by its run ID */
export async function killRunningReport(runId: string): Promise<boolean> {
  const entry = runningReports.get(runId);
  if (!entry) return false;
  try {
    const client = getDaemonClient();
    await client.killSession(entry.daemonSessionId);
  } catch {}

  // Mark the run as failed in the DB
  completeRun(runId, {
    status: 'failed',
    rawOutput: entry.output || '',
    renderedOutput: null,
    rendererType: 'plaintext',
    exitCode: -1,
    wasTruncated: false,
    error: 'Killed by user',
  });

  runningReports.delete(runId);
  return true;
}

export async function executeReport(
  schedule: ReportSchedule,
  triggeredBy: 'scheduler' | 'manual' = 'scheduler',
): Promise<string> {
  const sessionId = `report-${uuidv4()}`;
  const cwd = schedule.cwd || process.cwd();

  // Create run record first so we have the run ID for the file path
  const run = createRun({
    scheduleId: schedule.id,
    triggeredBy,
    promptSnapshot: schedule.prompt,
  });

  // Ensure reports directory exists
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Ensure WorkIQ EULA is pre-accepted so non-interactive runs don't get blocked
  ensureWorkIqEula();

  // Determine the output file path for this run
  const reportFilePath = getReportFilePath(run.id, schedule.rendererType);

  // Build args for non-interactive Copilot CLI mode (-p/--prompt)
  const reportPrompt = buildReportPrompt(schedule.prompt, schedule.rendererType, reportFilePath);

  // Write prompt to a temp file to avoid shell quoting issues
  const promptFile = path.join(REPORTS_DIR, `${run.id}.prompt.txt`);
  fs.writeFileSync(promptFile, reportPrompt, 'utf-8');

  const cliFlags = ['--allow-all-tools', '--add-dir', REPORTS_DIR, '--no-ask-user', '--no-color'];
  const flagsStr = cliFlags.join(' ');

  // Use PowerShell on Windows to read prompt from file (avoids cmd.exe quoting issues)
  const shell = IS_WINDOWS ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const promptFileSafe = promptFile.replace(/'/g, "''");
  const shellArgs = IS_WINDOWS
    ? ['-NoProfile', '-Command', `$p = Get-Content -Raw '${promptFileSafe}'; & ${CLI_COMMAND} ${CLI_ARGS.join(' ')} -- --prompt "$p" ${flagsStr}`]
    : ['-c', `${CLI_COMMAND} ${CLI_ARGS.join(' ')} -- --prompt "$(cat '${promptFile}')" ${flagsStr}`];

  // Store daemon session ID in DB
  updateRunDaemonSession(run.id, sessionId);

  // Register in running map
  runningReports.set(run.id, { daemonSessionId: sessionId, output: '', scheduleId: schedule.id });

  console.log(`[report-runner] Starting run ${run.id} for schedule "${schedule.name}" (${schedule.id})`);
  console.log(`[report-runner] CWD: ${cwd}`);
  console.log(`[report-runner] CLI command: ${shell} ${shellArgs.join(' ')}`);
  console.log(`[report-runner] Prompt:\n---\n${reportPrompt}\n---`);

  // Notify frontend that a run has started
  broadcastReportReady({
    runId: run.id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    status: 'running',
  });

  try {
    const client = getDaemonClient();
    await client.connect();

    const result = await client.runOnce({
      sessionId,
      cwd,
      shell,
      args: shellArgs,
      prompt: '', // prompt is passed via --prompt flag, not stdin
      timeoutMs: schedule.maxRuntimeMs,
      meta: { source: 'scheduled-report' },
      onOutput: (data) => {
        const entry = runningReports.get(run.id);
        if (entry) entry.output += normalizePtyOutput(data);
      },
    });

    const status = result.timedOut ? 'timed_out' as const
      : result.exitCode === 0 ? 'completed' as const
      : 'failed' as const;

    // Save raw PTY output as a log file for troubleshooting
    const logFile = path.join(REPORTS_DIR, `${run.id}.log`);
    try {
      fs.writeFileSync(logFile, result.output, 'utf-8');
      console.log(`[report-runner] Run ${run.id}: saved raw log (${result.output.length} bytes)`);
    } catch {}

    // Prefer agent-written file (clean, no PTY artifacts) over captured terminal output
    let cleanOutput: string;
    if (fs.existsSync(reportFilePath)) {
      cleanOutput = fs.readFileSync(reportFilePath, 'utf-8');
      console.log(`[report-runner] Run ${run.id}: using agent-written file (${cleanOutput.length} bytes)`);
    } else {
      // Fallback: normalize PTY output
      cleanOutput = normalizePtyOutput(result.output);
      console.log(`[report-runner] Run ${run.id}: agent didn't write file, using normalized PTY output`);
      try {
        fs.writeFileSync(reportFilePath, cleanOutput, 'utf-8');
      } catch (err) {
        console.error(`[report-runner] Run ${run.id}: failed to save report file:`, err);
      }
    }

    // Render the output
    let renderedOutput: string | null = null;
    try {
      renderedOutput = render(schedule.rendererType, cleanOutput);
    } catch (err) {
      console.error(`[report-runner] Renderer "${schedule.rendererType}" failed:`, err);
    }

    completeRun(run.id, {
      status,
      rawOutput: cleanOutput,
      renderedOutput,
      rendererType: schedule.rendererType,
      exitCode: result.exitCode,
      wasTruncated: result.wasTruncated,
      error: result.timedOut ? 'Execution timed out' : undefined,
    });

    console.log(`[report-runner] Run ${run.id} completed: status=${status}, exitCode=${result.exitCode}`);

    // Notify frontend
    broadcastReportReady({
      runId: run.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status,
    });

    // Prune old runs
    const pruned = pruneOldRuns(schedule.id, schedule.maxRunsRetained);
    if (pruned > 0) {
      console.log(`[report-runner] Pruned ${pruned} old runs for schedule "${schedule.name}"`);
    }

    runningReports.delete(run.id);
    return run.id;
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.error(`[report-runner] Run ${run.id} failed:`, errorMsg);

    completeRun(run.id, {
      status: 'failed',
      rawOutput: '',
      renderedOutput: null,
      rendererType: schedule.rendererType,
      exitCode: -1,
      wasTruncated: false,
      error: errorMsg,
    });

    broadcastReportReady({
      runId: run.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status: 'failed',
    });

    runningReports.delete(run.id);
    return run.id;
  }
}
