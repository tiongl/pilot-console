import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils';

describe('cn', () => {
  it('returns a single class unchanged', () => {
    expect(cn('text-sm')).toBe('text-sm');
  });

  it('combines multiple classes', () => {
    expect(cn('text-sm', 'font-bold')).toBe('text-sm font-bold');
  });

  it('includes conditional classes', () => {
    expect(cn('base', true && 'enabled', false && 'disabled')).toBe('base enabled');
  });

  it('flattens arrays of classes', () => {
    expect(cn(['text-sm', 'font-bold'], ['tracking-wide'])).toBe('text-sm font-bold tracking-wide');
  });

  it('ignores undefined, null, and false values', () => {
    expect(cn('base', undefined, null, false, 'visible')).toBe('base visible');
  });

  it('merges conflicting Tailwind classes', () => {
    expect(cn('px-2', 'px-4', 'text-sm', 'text-lg')).toBe('px-4 text-lg');
  });
});
