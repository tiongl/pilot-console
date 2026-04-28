import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// We test the StatusDot and status logic indirectly via DashboardLayout's ProjectNav.
// But since those are internal components, let's test the status priority logic
// and the API response → indicator mapping via a unit approach.

// --- Status priority logic (mirrors DashboardLayout.tsx) ---
type SessionStatus = 'idle' | 'busy' | 'exited';

function statusPriority(status: SessionStatus): number {
  switch (status) {
    case 'busy': return 2;
    case 'idle': return 1;
    case 'exited': return 0;
  }
}

describe('session status logic', () => {
  describe('statusPriority', () => {
    it('busy has highest priority', () => {
      expect(statusPriority('busy')).toBeGreaterThan(statusPriority('idle'));
      expect(statusPriority('busy')).toBeGreaterThan(statusPriority('exited'));
    });

    it('idle has higher priority than exited', () => {
      expect(statusPriority('idle')).toBeGreaterThan(statusPriority('exited'));
    });
  });

  describe('getSessionStatus computation (mirrors cli-bridge)', () => {
    const BUSY_THRESHOLD_MS = 10_000;

    function getSessionStatus(alive: boolean, lastOutputAt: number, now: number): SessionStatus {
      if (!alive) return 'exited';
      if (lastOutputAt > 0 && now - lastOutputAt < BUSY_THRESHOLD_MS) return 'busy';
      return 'idle';
    }

    it('returns idle when alive with no output', () => {
      expect(getSessionStatus(true, 0, Date.now())).toBe('idle');
    });

    it('returns busy when alive with recent output', () => {
      const now = Date.now();
      expect(getSessionStatus(true, now - 5000, now)).toBe('busy');
    });

    it('returns idle when alive with old output', () => {
      const now = Date.now();
      expect(getSessionStatus(true, now - 15000, now)).toBe('idle');
    });

    it('returns busy at exactly threshold boundary', () => {
      const now = Date.now();
      // At 9999ms, should still be busy
      expect(getSessionStatus(true, now - 9999, now)).toBe('busy');
    });

    it('returns idle at exactly threshold', () => {
      const now = Date.now();
      // At 10000ms, should be idle
      expect(getSessionStatus(true, now - 10000, now)).toBe('idle');
    });

    it('returns exited when not alive', () => {
      expect(getSessionStatus(false, Date.now(), Date.now())).toBe('exited');
    });

    it('returns exited regardless of recent output if not alive', () => {
      const now = Date.now();
      expect(getSessionStatus(false, now - 1000, now)).toBe('exited');
    });
  });

  describe('status merging (multiple sessions per project)', () => {
    interface SessionInfo {
      projectId: string;
      status: SessionStatus;
      exitCode: number | null;
    }

    function mergeStatuses(sessions: SessionInfo[]): Map<string, { status: SessionStatus; exitCode: number | null }> {
      const result = new Map<string, { status: SessionStatus; exitCode: number | null }>();
      for (const s of sessions) {
        const existing = result.get(s.projectId);
        if (!existing || statusPriority(s.status) > statusPriority(existing.status)) {
          result.set(s.projectId, { status: s.status, exitCode: s.exitCode });
        }
      }
      return result;
    }

    it('picks busy over idle for same project', () => {
      const merged = mergeStatuses([
        { projectId: 'p1', status: 'idle', exitCode: null },
        { projectId: 'p1', status: 'busy', exitCode: null },
      ]);
      expect(merged.get('p1')?.status).toBe('busy');
    });

    it('picks idle over exited for same project', () => {
      const merged = mergeStatuses([
        { projectId: 'p1', status: 'exited', exitCode: 1 },
        { projectId: 'p1', status: 'idle', exitCode: null },
      ]);
      expect(merged.get('p1')?.status).toBe('idle');
    });

    it('handles different projects independently', () => {
      const merged = mergeStatuses([
        { projectId: 'p1', status: 'busy', exitCode: null },
        { projectId: 'p2', status: 'exited', exitCode: 1 },
      ]);
      expect(merged.get('p1')?.status).toBe('busy');
      expect(merged.get('p2')?.status).toBe('exited');
    });

    it('returns empty map for no sessions', () => {
      const merged = mergeStatuses([]);
      expect(merged.size).toBe(0);
    });
  });
});
