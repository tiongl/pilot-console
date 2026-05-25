import { describe, expect, it } from 'vitest';
import { normalizePtyOutput, stripAnsi } from '../shared/strip-ansi';

describe('stripAnsi', () => {
  it('passes through plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('removes color codes', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m text')).toBe('red text');
  });

  it('removes cursor movement and erase sequences', () => {
    expect(stripAnsi('before\u001B[2K\u001B[1Gafter')).toBe('beforeafter');
  });

  it('removes simple two-character escape sequences', () => {
    // \x1B followed by a char in [@-Z\-_] range — e.g., \x1BD (index), \x1BM (reverse index)
    expect(stripAnsi('before\u001BDafter')).toBe('beforeafter');
  });

  it('removes multiple ANSI sequences in a single string', () => {
    const input = '\u001B[32mgreen\u001B[0m and \u001B[1Aup';
    expect(stripAnsi(input)).toBe('green and up');
  });

  it('handles empty strings', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('normalizePtyOutput', () => {
  it('normalizes Windows line endings', () => {
    expect(normalizePtyOutput('line 1\r\nline 2\r\n')).toBe('line 1\nline 2\n');
  });

  it('replaces orphan carriage returns with newlines', () => {
    expect(normalizePtyOutput('progress\rcomplete\rdone')).toBe('progress\ncomplete\ndone');
  });

  it('removes control characters while preserving tabs', () => {
    expect(normalizePtyOutput('a\u0000b\tkeep\u0007c\u001Fd')).toBe('ab\tkeepcd');
  });

  it('preserves tabs and newlines', () => {
    expect(normalizePtyOutput('col1\tcol2\ncol3\tcol4')).toBe('col1\tcol2\ncol3\tcol4');
  });

  it('combines ANSI stripping with line ending normalization', () => {
    const input = '\u001B[31mError\u001B[0m\r\nnext\rline\u0007';
    expect(normalizePtyOutput(input)).toBe('Error\nnext\nline');
  });
});
