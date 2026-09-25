import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 200 100" data-testid="mermaid-svg"></svg>' })),
  },
}));

import FilePreviewModal from '@/components/project/FilePreviewModal';

function mockFileFetch(payload: Record<string, unknown>, ok = true, status = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/file?')) {
      return { ok, status, json: async () => payload } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

describe('FilePreviewModal markdown rendering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a .md file as HTML by default (heading becomes an h1)', async () => {
    mockFileFetch({ content: '# Hello Heading\n\nSome text', size: 20 });

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="docs/readme.md" />,
    );

    const heading = await screen.findByRole('heading', { level: 1, name: 'Hello Heading' });
    expect(heading).toBeInTheDocument();
    // The raw '#' source should not be visible.
    expect(screen.queryByText('# Hello Heading')).not.toBeInTheDocument();
  });

  it('toggles between rendered markdown and raw source', async () => {
    mockFileFetch({ content: '# Hello Heading', size: 15 });

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="docs/readme.md" />,
    );

    await screen.findByRole('heading', { level: 1, name: 'Hello Heading' });

    // Toggle to source view.
    fireEvent.click(screen.getByTitle('Show source'));

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Hello Heading' }),
      ).not.toBeInTheDocument();
    });
    // Now the toggle should offer to render markdown again, and raw source is shown.
    expect(screen.getByTitle('Render markdown')).toBeInTheDocument();
    expect(screen.getByText(/# Hello Heading/)).toBeInTheDocument();
  });
});

describe('FilePreviewModal non-markdown behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows syntax-highlighted source for code files without a markdown toggle', async () => {
    mockFileFetch({ content: 'const x: number = 1;', size: 20 });

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="src/app.ts" />,
    );

    await screen.findByText(/const/);
    // No markdown toggle button for code files.
    expect(screen.queryByTitle('Show source')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Render markdown')).not.toBeInTheDocument();
    // Not rendered as a markdown heading (only the dialog title heading exists).
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('shows "Binary file" for binary content', async () => {
    mockFileFetch({ content: null, binary: true, size: 100 });

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="assets/blob.bin" />,
    );

    expect(await screen.findByText('Binary file')).toBeInTheDocument();
    expect(screen.queryByTitle('Show source')).not.toBeInTheDocument();
  });

  it('shows an error message when the fetch fails', async () => {
    mockFileFetch({}, false, 404);

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="missing.md" />,
    );

    expect(await screen.findByText('Failed to load file (404)')).toBeInTheDocument();
  });

  it('renders an image via the file-raw endpoint', async () => {
    // Fetch is still triggered but content is irrelevant for images.
    mockFileFetch({ content: null });

    render(
      <FilePreviewModal open onOpenChange={() => {}} projectId="p1" filePath="pics/logo.png" />,
    );

    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toContain('/api/projects/p1/file-raw');
    expect(img.getAttribute('src')).toContain('path=pics%2Flogo.png');
  });
});
