import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readDraft, writeDraft, clearDraft } from '@/lib/composer-draft';

describe('composer-draft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a draft keyed by sessionId', () => {
    writeDraft('sess-a', 'half-typed message');
    expect(readDraft('sess-a')).toBe('half-typed message');
  });

  it('returns null for an unknown session', () => {
    expect(readDraft('nope')).toBeNull();
  });

  it('namespaces drafts so one session never shows another\'s', () => {
    writeDraft('sess-a', 'draft A');
    writeDraft('sess-b', 'draft B');
    expect(readDraft('sess-a')).toBe('draft A');
    expect(readDraft('sess-b')).toBe('draft B');
  });

  it('clears the draft when an empty string is written', () => {
    writeDraft('sess-a', 'something');
    writeDraft('sess-a', '');
    expect(readDraft('sess-a')).toBeNull();
  });

  it('clears a draft explicitly', () => {
    writeDraft('sess-a', 'something');
    clearDraft('sess-a');
    expect(readDraft('sess-a')).toBeNull();
  });

  it('ignores a blank session id', () => {
    writeDraft('', 'orphan');
    expect(readDraft('')).toBeNull();
  });

  it('degrades silently when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeDraft('sess-a', 'boom')).not.toThrow();
    spy.mockRestore();
  });
});
