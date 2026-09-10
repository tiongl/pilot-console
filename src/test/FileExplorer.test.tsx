import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocked = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast: mocked.toast }));

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 200 100" data-testid="mermaid-svg"></svg>' })),
  },
}));

import FileExplorer from '@/components/project/FileExplorer';

describe('FileExplorer reveal action', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mocked.toast.success.mockClear();
    mocked.toast.error.mockClear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/files?')) {
        return {
          ok: true,
          json: async () => ({ items: [{ name: 'notes.txt', type: 'file', size: 12 }] }),
        } as Response;
      }
      if (url.includes('/file-reveal')) {
        return {
          ok: true,
          json: async () => ({ ok: true }),
        } as Response;
      }
      if (url.includes('/file?')) {
        return {
          ok: true,
          json: async () => ({ content: 'hello world', size: 11 }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the current file in the file system', async () => {
    render(<FileExplorer projectId="p1" embedded />);

    fireEvent.click(await screen.findByText('notes.txt'));
    await screen.findByText('hello world');

    fireEvent.click(screen.getByTitle('Show file in file system'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/projects/p1/file-reveal'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
    expect(mocked.toast.success).toHaveBeenCalledWith('Opened file location');
  });
});

describe('FileExplorer mermaid preview', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?')) {
        return {
          ok: true,
          json: async () => ({ items: [{ name: 'diagram.md', type: 'file', size: 40 }] }),
        } as Response;
      }
      if (url.includes('/file?')) {
        return {
          ok: true,
          json: async () => ({ content: '```mermaid\ngraph TD;A-->B;\n```\n', size: 40 }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a mermaid diagram with pan/zoom controls', async () => {
    render(<FileExplorer projectId="p1" embedded />);

    fireEvent.click(await screen.findByText('diagram.md'));

    const frame = await screen.findByTestId('mermaid-diagram');
    expect(frame.querySelector('svg')).toBeTruthy();
    // Fit-to-view is a no-op in jsdom (zero-size rects), so we start at 100%.
    expect(screen.getByText('100%')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Zoom in'));
    await waitFor(() => expect(screen.getByText('125%')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Zoom out'));
    await waitFor(() => expect(screen.getByText('100%')).toBeTruthy());
  });

  it('fits a small diagram by enlarging it to fill the frame', async () => {
    render(<FileExplorer projectId="p1" embedded />);

    fireEvent.click(await screen.findByText('diagram.md'));
    const frame = await screen.findByTestId('mermaid-diagram');

    // jsdom has no layout; give the frame a size so fit() has something to
    // work with. The diagram's own size comes from its viewBox (200x100).
    Object.defineProperty(frame, 'clientWidth', { value: 600, configurable: true });
    Object.defineProperty(frame, 'clientHeight', { value: 400, configurable: true });

    fireEvent.doubleClick(frame.firstElementChild as Element);

    // min((600-24)/200, (400-24)/100) = 2.88 — i.e. scaled up, not left at 100%.
    await waitFor(() => expect(screen.getByText('288%')).toBeTruthy());
  });
});

describe('FileExplorer state persistence', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/files?')) {
        return {
          ok: true,
          json: async () => ({ items: [{ name: 'notes.txt', type: 'file', size: 12 }] }),
        } as Response;
      }
      if (url.includes('/file?')) {
        return { ok: true, json: async () => ({ content: 'hello world', size: 11 }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reopens the last viewed file after the explorer is remounted', async () => {
    const first = render(<FileExplorer projectId="p1" embedded />);
    fireEvent.click(await screen.findByText('notes.txt'));
    await screen.findByText('hello world');

    first.unmount();

    render(<FileExplorer projectId="p1" embedded />);
    expect(await screen.findByText('hello world')).toBeTruthy();
  });

  it('keeps per-project state separate', async () => {
    const first = render(<FileExplorer projectId="p1" embedded />);
    fireEvent.click(await screen.findByText('notes.txt'));
    await screen.findByText('hello world');
    first.unmount();

    render(<FileExplorer projectId="p2" embedded />);
    await screen.findByText('notes.txt');
    expect(screen.queryByText('hello world')).toBeNull();
  });
});
