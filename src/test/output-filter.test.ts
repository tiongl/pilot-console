import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutputFilter, DEFAULT_FILTER_PATTERNS } from '../client/lib/output-filter';

function collect(filter: OutputFilter): string[] {
  const chunks: string[] = [];
  filter.setOutput((data) => chunks.push(data));
  return chunks;
}

describe('OutputFilter', () => {
  let filter: OutputFilter;
  let out: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    filter = new OutputFilter({ patterns: DEFAULT_FILTER_PATTERNS });
    out = collect(filter);
  });

  it('passes through normal lines unchanged', () => {
    filter.push('hello world\r\n');
    expect(out.join('')).toBe('hello world\r\n');
  });

  it('passes through multiple lines', () => {
    filter.push('line1\nline2\nline3\n');
    expect(out.join('')).toBe('line1\nline2\nline3\n');
  });

  it('filters the known TypeError line', () => {
    filter.push('✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\r\n');
    expect(out).toHaveLength(0);
  });

  it('filters TypeError with ANSI color codes around it', () => {
    // Simulates: \x1b[31m✗\x1b[0m TypeError: ...
    filter.push('\x1b[31m✗\x1b[0m TypeError: Cannot read properties of undefined (reading \'forEach\')\r\n');
    expect(out).toHaveLength(0);
  });

  it('filters TypeError with full-line ANSI wrapping', () => {
    filter.push('\x1b[31m✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\x1b[0m\n');
    expect(out).toHaveLength(0);
  });

  it('filters TypeError reading null', () => {
    filter.push('✗ TypeError: Cannot read properties of null (reading \'forEach\')\n');
    expect(out).toHaveLength(0);
  });

  it('keeps lines before and after a filtered line', () => {
    filter.push('before\n✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\nafter\n');
    expect(out.join('')).toBe('before\nafter\n');
  });

  it('handles \\r\\n line endings', () => {
    filter.push('keep\r\n✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\r\nkeep2\r\n');
    expect(out.join('')).toBe('keep\r\nkeep2\r\n');
  });

  it('buffers incomplete lines and flushes on timeout', () => {
    filter.push('prompt> ');
    // No output yet — line is incomplete
    expect(out).toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(out.join('')).toBe('prompt> ');
  });

  it('completes a buffered line when more data arrives', () => {
    filter.push('hel');
    expect(out).toHaveLength(0);

    filter.push('lo\n');
    expect(out.join('')).toBe('hello\n');
  });

  it('filters a line that arrives across two chunks', () => {
    filter.push('✗ TypeError: Cannot read properties');
    expect(out).toHaveLength(0);

    filter.push(' of undefined (reading \'forEach\')\n');
    // The complete line should be filtered
    expect(out).toHaveLength(0);
  });

  it('does not filter partial match that completes as non-match', () => {
    filter.push('✗ TypeError: something else entirely\n');
    expect(out.join('')).toBe('✗ TypeError: something else entirely\n');
  });

  it('preserves ANSI codes in passed-through lines', () => {
    const line = '\x1b[32mSuccess!\x1b[0m\r\n';
    filter.push(line);
    expect(out.join('')).toBe(line);
  });

  it('handles empty chunks gracefully', () => {
    filter.push('');
    filter.push('hello\n');
    expect(out.join('')).toBe('hello\n');
  });

  it('handles chunk that is just a line ending', () => {
    filter.push('hello');
    filter.push('\n');
    expect(out.join('')).toBe('hello\n');
  });

  it('flush() forces pending fragment out immediately', () => {
    filter.push('waiting...');
    expect(out).toHaveLength(0);

    filter.flush();
    expect(out.join('')).toBe('waiting...');
  });

  it('dispose() cancels pending flush', () => {
    filter.push('pending');
    filter.dispose();
    vi.advanceTimersByTime(300);
    expect(out).toHaveLength(0);
  });

  it('handles mixed filtered and unfiltered in rapid succession', () => {
    filter.push('ok1\n');
    filter.push('✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\n');
    filter.push('ok2\n');
    filter.push('✗ TypeError: Cannot read properties of null (reading \'map\')\n');
    filter.push('ok3\n');
    expect(out.join('')).toBe('ok1\nok2\nok3\n');
  });
});
