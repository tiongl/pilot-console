import { renderHook, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutomationBadge } from '@/hooks/useAutomationBadge';

describe('useAutomationBadge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    localStorage.setItem('automation_last_seen_at', '2024-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets the initial count from the API response', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ count: 3 }),
    } as Response);

    const { result } = renderHook(() => useAutomationBadge());

    await waitFor(() => {
      expect(result.current.count).toBe(3);
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/admin/runs/unseen-count?since=2024-01-01T00%3A00%3A00.000Z');
  });

  it('markSeen resets count and updates localStorage', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ count: 2 }),
    } as Response);

    const { result } = renderHook(() => useAutomationBadge());

    await waitFor(() => {
      expect(result.current.count).toBe(2);
    });

    act(() => {
      result.current.markSeen('2025-02-03T04:05:06.000Z');
    });

    expect(result.current.count).toBe(0);
    expect(localStorage.getItem('automation_last_seen_at')).toBe('2025-02-03T04:05:06.000Z');
  });

  it('increment increases the count by one', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ count: 1 }),
    } as Response);

    const { result } = renderHook(() => useAutomationBadge());

    await waitFor(() => {
      expect(result.current.count).toBe(1);
    });

    act(() => {
      result.current.increment();
    });

    expect(result.current.count).toBe(2);
  });

  it('handles fetch failure gracefully', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useAutomationBadge());

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    expect(result.current.count).toBe(0);
  });

  it('cleans up the refresh interval on unmount', () => {
    vi.useFakeTimers();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ count: 0 }),
    } as Response);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = renderHook(() => useAutomationBadge());

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
