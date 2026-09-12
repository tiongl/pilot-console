import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getProjectById, getWorktreeById, deleteWorktree } from './project-store';
import { getMergeLock, getMergeRequestForWorktree } from './merge-store';
import { closeDelegationsForWorktree } from './delegation-store';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 30_000;

export type CleanupBlockerCode =
  | 'uncommitted_changes'
  | 'unmerged_commits'
  | 'worker_busy'
  | 'merge_in_progress';

export interface CleanupBlocker {
  code: CleanupBlockerCode;
  detail: string;
}

/** How we concluded the branch's work is already on the base branch. */
export type MergeEvidence = 'pull_request' | 'merge_record' | 'ancestry' | 'worktree_missing';

export interface CleanupAssessment {
  worktreeId: string;
  name: string;
  branch: string;
  worktreePath: string;
  /** True when nothing would be lost by removing this worktree. */
  safe: boolean;
  blockers: CleanupBlocker[];
  merged: boolean;
  mergeEvidence: MergeEvidence | null;
  baseBranch: string | null;
  /** Set when a check could not run, e.g. git or gh was unavailable. */
  warnings: string[];
}

async function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 1_000_000,
  });
  // Trailing only: `status --porcelain` puts the status code in the first two
  // columns, so trimming the start would shift every path.
  return stdout.replace(/\s+$/, '');
}

/**
 * The branch this project merges into. Prefers whatever `origin/HEAD` points
 * at so forks and `master` repos work, then falls back to the usual names.
 */
export async function resolveBaseBranch(repoPath: string): Promise<string | null> {
  try {
    const ref = await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (ref) return ref.replace(/^origin\//, '');
  } catch {
    /* no origin/HEAD; fall through to the common names */
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`]);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Whether GitHub says a PR from this branch has already been merged. */
async function pullRequestMerged(repoPath: string, branch: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state', '--limit', '5'],
      { cwd: repoPath, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64_000 },
    );
    const rows = JSON.parse(stdout) as Array<{ state?: string }>;
    if (!rows.length) return null;
    return rows.some((row) => row.state === 'MERGED');
  } catch {
    return null;
  }
}

/**
 * Decide whether a worktree can be removed without losing work.
 *
 * Ancestry alone is not enough: this project merges by squashing, which
 * rewrites the commits, so a fully merged branch still looks unmerged to
 * `rev-list`. GitHub's own view of the pull request is therefore consulted
 * first, and ancestry is only the fallback for branches merged locally.
 */
export async function assessWorktreeCleanup(
  projectId: string,
  worktreeId: string,
): Promise<CleanupAssessment> {
  const worktree = getWorktreeById(worktreeId);
  if (!worktree) throw new Error('Worktree not found');
  if (worktree.projectId !== projectId) throw new Error('Worktree does not belong to this project');
  const project = getProjectById(projectId);
  if (!project) throw new Error('Project not found');

  const blockers: CleanupBlocker[] = [];
  const warnings: string[] = [];
  let merged = false;
  let mergeEvidence: MergeEvidence | null = null;
  let baseBranch: string | null = null;

  const onDisk = fs.existsSync(worktree.worktreePath);

  if (!onDisk) {
    // Nothing left to lose; removing the record is pure bookkeeping.
    merged = true;
    mergeEvidence = 'worktree_missing';
    warnings.push('The worktree directory no longer exists on disk; only its record will be removed.');
  } else {
    try {
      const dirty = await git(worktree.worktreePath, ['status', '--porcelain']);
      if (dirty) {
        const lines = dirty.split('\n').filter(Boolean);
        blockers.push({
          code: 'uncommitted_changes',
          detail: `${lines.length} uncommitted or untracked file(s): ${lines
            .slice(0, 5)
            .map((line) => line.slice(3))
            .join(', ')}${lines.length > 5 ? ', …' : ''}`,
        });
      }
    } catch (error) {
      warnings.push(`Could not check for uncommitted changes: ${(error as Error).message}`);
      blockers.push({
        code: 'uncommitted_changes',
        detail: 'The working tree could not be inspected, so it may still hold unsaved work.',
      });
    }

    const record = getMergeRequestForWorktree(worktreeId);
    if (record?.status === 'merged') {
      merged = true;
      mergeEvidence = 'merge_record';
    }

    if (!merged) {
      const viaPr = await pullRequestMerged(project.repoPath, worktree.branch);
      if (viaPr === true) {
        merged = true;
        mergeEvidence = 'pull_request';
      } else if (viaPr === null) {
        warnings.push('GitHub could not be consulted, so the merge check fell back to local history.');
      }
    }

    if (!merged) {
      baseBranch = await resolveBaseBranch(project.repoPath);
      if (!baseBranch) {
        warnings.push('No base branch could be determined, so merge status is unknown.');
        blockers.push({
          code: 'unmerged_commits',
          detail: 'Could not determine the base branch to compare against.',
        });
      } else {
        // Without this, a branch merged minutes ago still looks unmerged.
        try {
          await git(project.repoPath, ['fetch', 'origin', baseBranch, '--quiet'], FETCH_TIMEOUT_MS);
        } catch {
          warnings.push(`Could not fetch origin/${baseBranch}; comparing against the local copy.`);
        }
        try {
          const range = `origin/${baseBranch}..${worktree.branch}`;
          const count = Number(await git(project.repoPath, ['rev-list', '--count', range]));
          if (Number.isFinite(count) && count === 0) {
            merged = true;
            mergeEvidence = 'ancestry';
          } else {
            blockers.push({
              code: 'unmerged_commits',
              detail: `${count} commit(s) on ${worktree.branch} are not on ${baseBranch}, and no merged pull request was found.`,
            });
          }
        } catch (error) {
          blockers.push({
            code: 'unmerged_commits',
            detail: `Could not compare ${worktree.branch} against ${baseBranch}: ${(error as Error).message}`,
          });
        }
      }
    }
  }

  const lock = getMergeLock(projectId);
  if (lock && !lock.stale && lock.heldByWorktreeId === worktreeId) {
    blockers.push({
      code: 'merge_in_progress',
      detail: 'A merge is currently running for this worktree.',
    });
  }

  try {
    const { findLiveWorktreeAgent } = await import('./agent-bridge');
    const live = findLiveWorktreeAgent(projectId, worktreeId);
    if (live?.status === 'busy') {
      blockers.push({
        code: 'worker_busy',
        detail: 'A worker is mid-turn in this worktree. Cancel it first.',
      });
    }
  } catch (error) {
    warnings.push(`Could not check for a running worker: ${(error as Error).message}`);
  }

  return {
    worktreeId,
    name: worktree.name,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    safe: blockers.length === 0,
    blockers,
    merged,
    mergeEvidence,
    baseBranch,
    warnings,
  };
}

export interface CloseWorktreeResult {
  worktreeId: string;
  name: string;
  branch: string;
  closedSessions: string[];
  closedDelegations: number;
  assessment: CleanupAssessment;
}

/**
 * Remove a worktree and retire everything hanging off it.
 *
 * Refuses unless the assessment comes back clean. `force` exists only for the
 * user-driven UI path, where the dialog spells out what is about to be lost —
 * agents never get to set it.
 */
export async function closeWorktree(
  projectId: string,
  worktreeId: string,
  options: { force?: boolean } = {},
): Promise<CloseWorktreeResult> {
  const assessment = await assessWorktreeCleanup(projectId, worktreeId);
  if (!assessment.safe && !options.force) {
    const reasons = assessment.blockers.map((b) => `${b.code}: ${b.detail}`).join('; ');
    throw new Error(`Worktree ${assessment.name} is not safe to close — ${reasons}`);
  }

  const { endWorktreeAgentSessions } = await import('./agent-bridge');
  const closedSessions = await endWorktreeAgentSessions(projectId, worktreeId);
  const closedDelegations = closeDelegationsForWorktree(worktreeId);
  deleteWorktree(worktreeId, projectId);

  return {
    worktreeId,
    name: assessment.name,
    branch: assessment.branch,
    closedSessions,
    closedDelegations,
    assessment,
  };
}
