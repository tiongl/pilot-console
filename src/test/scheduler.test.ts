import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportSchedule } from '../shared/schedule-store';

function makeSchedule(overrides: Partial<ReportSchedule> = {}): ReportSchedule {
  return {
    id: 'schedule-1',
    name: 'Weekday report',
    prompt: 'Run report',
    cronExpression: '0 9 * * 1-5',
    rendererType: 'plaintext',
    enabled: true,
    cwd: null,
    maxRuntimeMs: 300000,
    maxRunsRetained: 50,
    createdBy: null,
    nextRunAt: null,
    lastStartedAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('scheduler', () => {
  let listSchedulesMock: ReturnType<typeof vi.fn>;
  let getDueSchedulesMock: ReturnType<typeof vi.fn>;
  let updateScheduleMock: ReturnType<typeof vi.fn>;
  let executeReportMock: ReturnType<typeof vi.fn>;
  let scheduler: typeof import('../server/scheduler');

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-06T08:00:00.000Z'));

    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    listSchedulesMock = vi.fn().mockReturnValue([]);
    getDueSchedulesMock = vi.fn().mockReturnValue([]);
    updateScheduleMock = vi.fn();
    executeReportMock = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../shared/schedule-store', () => ({
      listSchedules: listSchedulesMock,
      getDueSchedules: getDueSchedulesMock,
      updateSchedule: updateScheduleMock,
    }));

    vi.doMock('../server/report-runner', () => ({
      executeReport: executeReportMock,
    }));

    scheduler = await import('../server/scheduler');
  });

  afterEach(() => {
    scheduler.stopScheduler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('getNextRunTime returns a valid ISO string for valid cron', () => {
    const nextRun = scheduler.getNextRunTime('0 9 * * 1-5');

    expect(nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(nextRun!))).toBe(false);
  });

  it('getNextRunTime returns null for an invalid cron expression', () => {
    expect(scheduler.getNextRunTime('not a cron')).toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it('getNextRunTime returns a time in the future', () => {
    const nextRun = scheduler.getNextRunTime('0 9 * * 1-5');

    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
  });

  it('startScheduler initializes schedules, ticks immediately, and stopScheduler halts future ticks', async () => {
    const staleSchedule = makeSchedule({
      id: 'stale',
      name: 'Needs init',
      nextRunAt: null,
    });
    const freshSchedule = makeSchedule({
      id: 'fresh',
      name: 'Already scheduled',
      nextRunAt: '2025-01-06T09:00:00.000Z',
    });
    const disabledSchedule = makeSchedule({
      id: 'disabled',
      enabled: false,
      nextRunAt: null,
    });
    const dueSchedule = makeSchedule({
      id: 'due',
      name: 'Due now',
      nextRunAt: '2025-01-06T07:59:00.000Z',
    });

    listSchedulesMock.mockReturnValue([staleSchedule, freshSchedule, disabledSchedule]);
    getDueSchedulesMock.mockReturnValueOnce([dueSchedule]).mockReturnValue([]);

    scheduler.startScheduler();
    await Promise.resolve();

    expect(listSchedulesMock).toHaveBeenCalledTimes(1);
    expect(getDueSchedulesMock).toHaveBeenCalledTimes(1);
    expect(updateScheduleMock).toHaveBeenCalledTimes(2);
    expect(updateScheduleMock).toHaveBeenNthCalledWith(
      1,
      'stale',
      expect.objectContaining({ nextRunAt: expect.any(String) }),
    );
    expect(updateScheduleMock).toHaveBeenNthCalledWith(
      2,
      'due',
      expect.objectContaining({
        lastStartedAt: expect.any(String),
        nextRunAt: expect.any(String),
      }),
    );
    expect(executeReportMock).toHaveBeenCalledTimes(1);
    expect(executeReportMock).toHaveBeenCalledWith(dueSchedule, 'scheduler');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDueSchedulesMock).toHaveBeenCalledTimes(2);

    scheduler.stopScheduler();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDueSchedulesMock).toHaveBeenCalledTimes(2);
  });
});
