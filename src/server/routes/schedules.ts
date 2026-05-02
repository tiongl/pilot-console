import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../middleware/auth';
import {
  createSchedule,
  getScheduleById,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  listRunsForSchedule,
  listAllRuns,
  countAllRuns,
  countRunsSince,
  getRunById,
  deleteRunById,
  deleteAllRuns,
  markRunsRead,
  markRunsUnread,
} from '../../shared/schedule-store';
import { getRendererTypes } from '../renderers';
import { getNextRunTime } from '../scheduler';
import { executeReport, getRunningReportOutput, killRunningReport, getRunningReportForSchedule, getReportFilePath } from '../report-runner';

const router = Router();
const REPORTS_DIR = path.join(require('os').homedir(), '.clippy', 'reports');

router.use(requireAuth);

// --- Renderer types ---
router.get('/renderers', (_req, res) => {
  res.json({ renderers: getRendererTypes() });
});

// --- Schedules CRUD ---
router.get('/schedules', (_req, res) => {
  res.json({ schedules: listSchedules() });
});

router.post('/schedules', (req, res) => {
  try {
    const { name, prompt, cronExpression, rendererType, cwd, maxRuntimeMs, maxRunsRetained } = req.body;
    if (!name?.trim() || !prompt?.trim() || !cronExpression?.trim()) {
      res.status(400).json({ error: 'name, prompt, and cronExpression are required' });
      return;
    }

    // Validate cron expression
    const nextRun = getNextRunTime(cronExpression);
    if (!nextRun) {
      res.status(400).json({ error: 'Invalid cron expression' });
      return;
    }

    const schedule = createSchedule({
      name: name.trim(),
      prompt: prompt.trim(),
      cronExpression: cronExpression.trim(),
      rendererType,
      cwd: cwd || null,
      maxRuntimeMs,
      maxRunsRetained,
      createdBy: req.user?.id,
      nextRunAt: nextRun,
    });

    res.status(201).json(schedule);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Export/Import (must be before :id routes) ---
router.get('/schedules/export', (_req, res) => {
  const schedules = listSchedules();
  const exportData = schedules.map(s => ({
    name: s.name,
    prompt: s.prompt,
    cronExpression: s.cronExpression,
    rendererType: s.rendererType,
    enabled: s.enabled,
    cwd: s.cwd,
    maxRuntimeMs: s.maxRuntimeMs,
    maxRunsRetained: s.maxRunsRetained,
  }));
  res.setHeader('Content-Disposition', 'attachment; filename="clippy-automations.json"');
  res.json({ version: 1, schedules: exportData });
});

router.post('/schedules/import', (req, res) => {
  try {
    const { schedules: imported, mode } = req.body;
    if (!Array.isArray(imported) || imported.length === 0) {
      res.status(400).json({ error: 'No schedules to import' });
      return;
    }

    const results: { name: string; status: 'created' | 'skipped' | 'error'; error?: string }[] = [];
    const existing = listSchedules();
    const existingNames = new Set(existing.map(s => s.name));

    for (const s of imported) {
      if (!s.name?.trim() || !s.prompt?.trim() || !s.cronExpression?.trim()) {
        results.push({ name: s.name || '(unnamed)', status: 'error', error: 'Missing required fields' });
        continue;
      }

      if (mode !== 'overwrite' && existingNames.has(s.name)) {
        results.push({ name: s.name, status: 'skipped', error: 'Already exists' });
        continue;
      }

      if (mode === 'overwrite' && existingNames.has(s.name)) {
        const old = existing.find(e => e.name === s.name);
        if (old) deleteSchedule(old.id);
      }

      const nextRun = getNextRunTime(s.cronExpression);
      if (!nextRun) {
        results.push({ name: s.name, status: 'error', error: 'Invalid cron expression' });
        continue;
      }

      try {
        createSchedule({
          name: s.name.trim(),
          prompt: s.prompt.trim(),
          cronExpression: s.cronExpression.trim(),
          rendererType: s.rendererType || 'plaintext',
          cwd: s.cwd || null,
          maxRuntimeMs: s.maxRuntimeMs || 300000,
          maxRunsRetained: s.maxRunsRetained || 50,
          createdBy: req.user?.id,
          nextRunAt: nextRun,
          enabled: s.enabled !== false,
        });
        results.push({ name: s.name, status: 'created' });
      } catch (err: any) {
        results.push({ name: s.name, status: 'error', error: err.message });
      }
    }

    res.json({ results });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/schedules/:id', (req, res) => {
  const schedule = getScheduleById(req.params.id);
  if (!schedule) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(schedule);
});

router.put('/schedules/:id', (req, res) => {
  try {
    const data = req.body;

    // If cron changed, recompute next run
    if (data.cronExpression) {
      const nextRun = getNextRunTime(data.cronExpression);
      if (!nextRun) {
        res.status(400).json({ error: 'Invalid cron expression' });
        return;
      }
      data.nextRunAt = nextRun;
    }

    const schedule = updateSchedule(req.params.id, data);
    res.json(schedule);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/schedules/:id', (req, res) => {
  deleteSchedule(req.params.id);
  res.json({ ok: true });
});

// --- Manual trigger ---
router.post('/schedules/:id/run', async (req, res) => {
  const schedule = getScheduleById(req.params.id);
  if (!schedule) { res.status(404).json({ error: 'Not found' }); return; }

  try {
    const runId = await executeReport(schedule, 'manual');
    res.json({ runId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Runs ---
router.get('/schedules/:id/runs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const runs = listRunsForSchedule(req.params.id, limit);
  res.json({ runs });
});

// List all runs across all schedules (for automation history)
router.get('/runs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = parseInt(req.query.offset as string) || 0;
  const since = req.query.since as string | undefined;
  const scheduleId = req.query.scheduleId as string | undefined;
  const runs = listAllRuns(limit, since, offset, scheduleId);
  const total = countAllRuns(scheduleId);
  res.json({ runs, total });
});

// Count unseen runs (for badge)
router.get('/runs/unseen-count', (req, res) => {
  const since = req.query.since as string;
  if (!since) {
    res.json({ count: 0 });
    return;
  }
  const count = countRunsSince(since);
  res.json({ count });
});

// Batch delete runs
router.post('/runs/batch-delete', (req, res) => {
  if (req.body.all) {
    if (fs.existsSync(REPORTS_DIR)) {
      try {
        const files = fs.readdirSync(REPORTS_DIR);
        for (const f of files) {
          if (!f.endsWith('.prompt.txt')) {
            try { fs.unlinkSync(path.join(REPORTS_DIR, f)); } catch {}
          }
        }
      } catch {}
    }
    const deleted = deleteAllRuns();
    res.json({ ok: true, deleted });
    return;
  }

  const ids: string[] = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  let deleted = 0;
  for (const id of ids) {
    const run = getRunById(id);
    if (!run) continue;
    const filePath = getReportFilePath(run.id, run.rendererType ?? 'plaintext');
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    deleteRunById(id);
    deleted++;
  }
  res.json({ ok: true, deleted });
});

// Mark runs as read
router.post('/runs/mark-read', (req, res) => {
  const ids: string[] = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  markRunsRead(ids);
  res.json({ ok: true });
});

// Mark runs as unread
router.post('/runs/mark-unread', (req, res) => {
  const ids: string[] = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' });
    return;
  }
  markRunsUnread(ids);
  res.json({ ok: true });
});

// Live output for a running report
router.get('/runs/:id/live', (req, res) => {
  const live = getRunningReportOutput(req.params.id);
  if (!live) {
    res.json({ running: false, output: '' });
    return;
  }
  res.json({ running: true, output: live.output });
});

// Kill a running report
router.post('/runs/:id/kill', async (req, res) => {
  const killed = await killRunningReport(req.params.id);
  if (!killed) {
    res.status(404).json({ error: 'No running report found with this ID' });
    return;
  }
  res.json({ ok: true });
});

// Get the currently running run for a schedule
router.get('/schedules/:id/running', (req, res) => {
  const runId = getRunningReportForSchedule(req.params.id);
  res.json({ runId });
});

router.get('/runs/:id', (req, res) => {
  const run = getRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(run);
});

// Serve the saved report file directly (for download / raw view)
router.get('/runs/:id/file', (req, res) => {
  const run = getRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }

  const filePath = getReportFilePath(run.id, run.rendererType ?? 'plaintext');

  // 1. Serve from file on disk
  if (fs.existsSync(filePath)) {
    const mimeTypes: Record<string, string> = {
      md: 'text/markdown; charset=utf-8',
      json: 'application/json; charset=utf-8',
      html: 'text/html; charset=utf-8',
      txt: 'text/plain; charset=utf-8',
    };
    const ext = path.extname(filePath).slice(1);
    res.setHeader('Content-Type', mimeTypes[ext] ?? 'text/plain; charset=utf-8');
    res.send(fs.readFileSync(filePath, 'utf-8'));
    return;
  }

  // 2. Fall back to raw output from DB
  if (run.rawOutput) {
    const mimeTypes: Record<string, string> = {
      markdown: 'text/markdown; charset=utf-8',
      json: 'application/json; charset=utf-8',
      html: 'text/html; charset=utf-8',
    };
    res.setHeader('Content-Type', mimeTypes[run.rendererType ?? ''] ?? 'text/plain; charset=utf-8');
    res.send(run.rawOutput);
    return;
  }

  // 3. Fall back to error or status message so we never 404 for a known run
  const fallback = run.error
    ? `Error: ${run.error}`
    : `No output available for this run (status: ${run.status}).`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fallback);
});

// Serve log file (raw PTY output) for troubleshooting
router.get('/runs/:id/log', (req, res) => {
  const run = getRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }

  const logPath = path.join(REPORTS_DIR, `${run.id}.log`);
  const promptPath = path.join(REPORTS_DIR, `${run.id}.prompt.txt`);

  const parts: string[] = [];

  // Include prompt
  if (fs.existsSync(promptPath)) {
    parts.push('=== PROMPT ===\n' + fs.readFileSync(promptPath, 'utf-8'));
  }

  // Include log
  if (fs.existsSync(logPath)) {
    parts.push('=== PTY OUTPUT (raw) ===\n' + fs.readFileSync(logPath, 'utf-8'));
  }

  // Include error/status from DB
  if (run.error) {
    parts.push(`=== ERROR ===\n${run.error}`);
  }
  parts.push(`=== STATUS: ${run.status} | EXIT CODE: ${run.exitCode ?? 'N/A'} ===`);

  if (parts.length === 1) {
    // Only the status line — no files found
    if (run.rawOutput) {
      parts.unshift('=== RAW OUTPUT (from DB) ===\n' + run.rawOutput);
    }
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(parts.join('\n\n'));
});

// Delete a run and its report file
router.delete('/runs/:id', (req, res) => {
  const run = getRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }

  // Delete report file if it exists
  const filePath = getReportFilePath(run.id, run.rendererType ?? 'plaintext');
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {}
  }

  deleteRunById(req.params.id);
  res.json({ ok: true });
});

export default router;
