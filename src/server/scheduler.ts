/**
 * In-process scheduler — checks for due schedules every 60 seconds
 * and triggers report execution.
 */

import { CronExpressionParser } from 'cron-parser';
import {
  getDueSchedules,
  updateSchedule,
  listSchedules,
} from '../shared/schedule-store';
import { executeReport } from './report-runner';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const runningJobs = new Set<string>(); // schedule IDs currently executing

/**
 * Compute the next run time from a cron expression, relative to now.
 */
export function getNextRunTime(cronExpression: string): string | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression);
    return interval.next().toISOString();
  } catch (err) {
    console.error(`[scheduler] Invalid cron expression "${cronExpression}":`, err);
    return null;
  }
}

/**
 * Start the scheduler loop. Should be called once at server startup.
 */
export function startScheduler(): void {
  if (schedulerInterval) {
    console.warn('[scheduler] Already running');
    return;
  }

  console.log('[scheduler] Starting scheduler (60s interval)');

  // On startup, recalculate next_run_at for all enabled schedules that need it
  initializeNextRunTimes();

  // Check every 60 seconds
  schedulerInterval = setInterval(tick, 60_000);

  // Also run an immediate check
  tick();
}

/**
 * Stop the scheduler loop.
 */
export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[scheduler] Stopped');
  }
}

/**
 * Initialize next_run_at for schedules that don't have one yet
 * or whose next_run_at is in the past (missed while server was down).
 */
function initializeNextRunTimes(): void {
  const schedules = listSchedules();
  const now = new Date().toISOString();

  for (const schedule of schedules) {
    if (!schedule.enabled) continue;

    if (!schedule.nextRunAt || schedule.nextRunAt <= now) {
      // Recalculate — skip missed runs
      const nextRun = getNextRunTime(schedule.cronExpression);
      if (nextRun) {
        updateSchedule(schedule.id, { nextRunAt: nextRun });
        console.log(`[scheduler] Initialized next run for "${schedule.name}": ${nextRun}`);
      }
    }
  }
}

async function tick(): Promise<void> {
  try {
    const due = getDueSchedules();
    if (due.length === 0) return;

    console.log(`[scheduler] ${due.length} schedule(s) due`);

    for (const schedule of due) {
      // Skip if already running (in-process guard)
      if (runningJobs.has(schedule.id)) {
        console.log(`[scheduler] Skipping "${schedule.name}" — already running`);
        continue;
      }

      runningJobs.add(schedule.id);

      // Update last_started_at and advance next_run_at
      const nextRun = getNextRunTime(schedule.cronExpression);
      updateSchedule(schedule.id, {
        lastStartedAt: new Date().toISOString(),
        nextRunAt: nextRun,
      });

      // Execute in background (don't block the tick loop)
      executeReport(schedule, 'scheduler')
        .catch((err) => {
          console.error(`[scheduler] Error running schedule "${schedule.name}":`, err);
        })
        .finally(() => {
          runningJobs.delete(schedule.id);
        });
    }
  } catch (err) {
    console.error('[scheduler] Tick error:', err);
  }
}
