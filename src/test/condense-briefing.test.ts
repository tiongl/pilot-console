import { describe, expect, it } from 'vitest';
import { condenseBriefing } from '../shared/project-lead-tools';

describe('condenseBriefing', () => {
  it('collapses whitespace and trims', () => {
    expect(condenseBriefing('  Shipped  the\n\nauth fix.  ')).toBe('Shipped the auth fix.');
  });

  it('leaves short summaries untouched', () => {
    const short = 'Decided to ship behind a flag.';
    expect(condenseBriefing(short)).toBe(short);
  });

  it('truncates long summaries to the cap with an ellipsis', () => {
    const long = 'word '.repeat(200);
    const result = condenseBriefing(long);
    expect(result.length).toBeLessThanOrEqual(281);
    expect(result.endsWith('…')).toBe(true);
  });

  it('prefers breaking at a sentence or word boundary', () => {
    const long = `${'a'.repeat(100)}. ${'b '.repeat(200)}`;
    const result = condenseBriefing(long);
    expect(result).not.toMatch(/\s…$/);
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects a custom cap', () => {
    const result = condenseBriefing('one two three four five six seven', 10);
    expect(result.length).toBeLessThanOrEqual(11);
    expect(result.endsWith('…')).toBe(true);
  });
});
