import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AgentTranscriptEvent } from '@/types';
import { readTranscript, writeTranscript, clearTranscript } from '@/lib/transcript-cache';

const user = (id: string, content: string): AgentTranscriptEvent => ({
  kind: 'user',
  id,
  ts: 1,
  content,
});

describe('transcript-cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a transcript keyed by sessionId', () => {
    const events = [user('u1', 'hi'), user('u2', 'there')];
    writeTranscript('sess-a', events);
    expect(readTranscript('sess-a')).toEqual(events);
  });

  it('returns null for an unknown session', () => {
    expect(readTranscript('nope')).toBeNull();
  });

  it('does not leak a transcript across sessionIds', () => {
    writeTranscript('sess-a', [user('u1', 'a')]);
    expect(readTranscript('sess-b')).toBeNull();
  });

  it('drops system events before caching', () => {
    writeTranscript('sess-a', [
      user('u1', 'hi'),
      { kind: 'system', id: 's1', ts: 1, content: 'noise' },
    ]);
    const got = readTranscript('sess-a');
    expect(got).toHaveLength(1);
    expect(got?.[0].id).toBe('u1');
  });

  it('caps the cached events to the most recent window', () => {
    const many = Array.from({ length: 500 }, (_, i) => user(`u${i}`, `m${i}`));
    writeTranscript('sess-a', many);
    const got = readTranscript('sess-a');
    expect(got).toHaveLength(400);
    // Keeps the most recent events.
    expect(got?.[0].id).toBe('u100');
    expect(got?.at(-1)?.id).toBe('u499');
  });

  it('discards a payload whose schema version does not match', () => {
    localStorage.setItem(
      'pilot-console-agent-transcript-v1:sess-a',
      JSON.stringify({ version: 999, sessionId: 'sess-a', events: [user('u1', 'hi')], savedAt: 1 }),
    );
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('discards a payload whose stored sessionId does not match the key', () => {
    localStorage.setItem(
      'pilot-console-agent-transcript-v1:sess-a',
      JSON.stringify({ version: 1, sessionId: 'someone-else', events: [user('u1', 'hi')], savedAt: 1 }),
    );
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('discards a malformed payload', () => {
    localStorage.setItem('pilot-console-agent-transcript-v1:sess-a', '{ not json');
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('discards a payload containing malformed events', () => {
    localStorage.setItem(
      'pilot-console-agent-transcript-v1:sess-a',
      JSON.stringify({ version: 1, sessionId: 'sess-a', events: [{ nope: true }], savedAt: 1 }),
    );
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('evicts the oldest sessions past the cap', () => {
    for (let i = 0; i < 25; i++) {
      writeTranscript(`sess-${i}`, [user('u1', `m${i}`)]);
    }
    // The 5 oldest sessions should have been evicted (cap is 20).
    expect(readTranscript('sess-0')).toBeNull();
    expect(readTranscript('sess-4')).toBeNull();
    expect(readTranscript('sess-5')).not.toBeNull();
    expect(readTranscript('sess-24')).not.toBeNull();
  });

  it('clears a cached session', () => {
    writeTranscript('sess-a', [user('u1', 'hi')]);
    clearTranscript('sess-a');
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('read degrades to null when storage throws', () => {
    writeTranscript('sess-a', [user('u1', 'hi')]);
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    expect(readTranscript('sess-a')).toBeNull();
  });

  it('write degrades silently when storage throws', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writeTranscript('sess-a', [user('u1', 'hi')])).not.toThrow();
  });
});
