import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from '@/hooks/use-mobile';

describe('useIsMobile', () => {
  beforeEach(() => {
    let currentWidth = 1024;

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: currentWidth,
    });

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: currentWidth < 768,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('returns false for desktop widths', async () => {
    window.innerWidth = 768;

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it('returns true for mobile widths', async () => {
    window.innerWidth = 767;

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
