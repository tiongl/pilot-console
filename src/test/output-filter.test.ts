import { describe, it, expect, beforeEach } from 'vitest';
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

  it('passes through normal incomplete fragments immediately', () => {
    filter.push('prompt> ');
    expect(out.join('')).toBe('prompt> ');
  });

  it('passes through normal chunks with no newlines immediately', () => {
    filter.push('typing...');
    expect(out.join('')).toBe('typing...');
  });

  it('filters TypeError fragment WITHOUT a newline', () => {
    filter.push('✗ TypeError: Cannot read properties of undefined (reading \'forEach\')');
    expect(out).toHaveLength(0);
  });

  it('filters TypeError trailing fragment after good lines', () => {
    filter.push('ok\nTypeError: Cannot read properties of undefined (reading \'forEach\')');
    expect(out.join('')).toBe('ok\n');
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
    filter.push('\n');
    expect(out.join('')).toBe('\n');
  });

  it('handles mixed filtered and unfiltered in rapid succession', () => {
    filter.push('ok1\n');
    filter.push('✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\n');
    filter.push('ok2\n');
    filter.push('✗ TypeError: Cannot read properties of null (reading \'map\')\n');
    filter.push('ok3\n');
    expect(out.join('')).toBe('ok1\nok2\nok3\n');
  });

  it('filters line embedded in a mixed chunk', () => {
    const chunk = 'good\n✗ TypeError: Cannot read properties of undefined (reading \'forEach\')\nalso good\n';
    filter.push(chunk);
    expect(out.join('')).toBe('good\nalso good\n');
  });

  it('filters TypeError with cursor movement prefixes', () => {
    // Terminal may have cursor-position ANSI before the error
    filter.push('\x1b[2K\x1b[1G\x1b[31m✗\x1b[39m TypeError: Cannot read properties of undefined (reading \'forEach\')\n');
    expect(out).toHaveLength(0);
  });

  describe('TUI cursor-positioned output', () => {
    it('redacts TypeError in cursor-positioned TUI chunk', () => {
      // Simulates Copilot CLI TUI redraw with cursor positioning
      const chunk =
        '\x1b[H\x1b[K\x1b[32m\r\n' +
        '● \x1b[m\x1b[1mEdit \x1b[22mfile.tsx\x1b[K\r\n' +
        '\x1b[31m\r\n' +
        '\x1b[5;1H✗ \x1b[m\x1b[1mTypeError: Cannot read properties of undefined (reading \'forEach\') \x1b[22m\x1b[K\r\n' +
        '\x1b[32m● \x1b[mDone\x1b[K\r\n';
      filter.push(chunk);
      const result = out.join('');
      // Cursor positioning preserved
      expect(result).toContain('\x1b[5;1H');
      expect(result).toContain('\x1b[H');
      // Error text redacted (replaced with spaces)
      expect(result).not.toContain('TypeError');
      expect(result).not.toContain('✗');
      // Other content preserved
      expect(result).toContain('Edit');
      expect(result).toContain('Done');
    });

    it('preserves all ANSI escape sequences in TUI redaction', () => {
      const chunk =
        '\x1b[H\x1b[32m● \x1b[mOK\r\n' +
        '\x1b[3;1H\x1b[31m✗ \x1b[m\x1b[1mTypeError: Cannot read properties of undefined (reading \'forEach\') \x1b[22m\x1b[K\r\n';
      filter.push(chunk);
      const result = out.join('');
      // All ANSI sequences preserved
      expect(result).toContain('\x1b[H');
      expect(result).toContain('\x1b[32m');
      expect(result).toContain('\x1b[3;1H');
      expect(result).toContain('\x1b[31m');
      expect(result).toContain('\x1b[m');
      expect(result).toContain('\x1b[1m');
      expect(result).toContain('\x1b[22m');
      expect(result).toContain('\x1b[K');
      // Error text gone
      expect(result).not.toContain('TypeError');
    });

    it('does not redact non-matching TUI content', () => {
      const chunk =
        '\x1b[H\x1b[32m● \x1b[mAll good\r\n' +
        '\x1b[3;1H\x1b[32m● \x1b[mStill good\r\n';
      filter.push(chunk);
      const result = out.join('');
      expect(result).toBe(chunk);
    });
  });
});
