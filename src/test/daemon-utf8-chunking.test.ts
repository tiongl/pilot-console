/**
 * Regression test for a subtle terminal-corruption bug: both `daemon/index.ts`
 * (command channel, server → daemon) and `daemon/client.ts` (response channel,
 * daemon → server) accumulate raw socket chunks into a string before framing
 * on newlines. The original code called `chunk.toString()` (UTF-8) on each
 * chunk independently before concatenating.
 *
 * Buffer.toString('utf8') is not chunk-boundary-safe: if a chunk ends in the
 * middle of a multi-byte UTF-8 sequence (very likely for CJK text, emoji, or
 * the box-drawing/spinner glyphs the Copilot CLI's TUI renders), Node replaces
 * the incomplete trailing bytes with U+FFFD *before* the next chunk arrives to
 * complete them — permanently corrupting that character. Because it depends
 * on where the OS happens to split a TCP chunk, this shows up as intermittent
 * "garbled" terminal output, matching real-world reports.
 *
 * The fix (both files) is to use `string_decoder.StringDecoder`, which holds
 * back incomplete trailing bytes until the next chunk completes them.
 */
import { describe, it, expect } from 'vitest';
import { StringDecoder } from 'string_decoder';

/** A 4-byte UTF-8 character (outside the BMP, encoded as a surrogate pair in JS). */
const EMOJI = '🎉';
/** A 3-byte UTF-8 character (CJK), the more common real-world case. */
const CJK = '你';

function splitIntoChunks(text: string, splitByteOffset: number): [Buffer, Buffer] {
  const full = Buffer.from(text, 'utf8');
  return [full.subarray(0, splitByteOffset), full.subarray(splitByteOffset)];
}

describe('socket chunk reassembly for multi-byte UTF-8', () => {
  it('demonstrates the bug: naive per-chunk toString() corrupts a split character', () => {
    const text = `hello ${EMOJI} world`;
    const markerBytes = Buffer.from(EMOJI, 'utf8');
    expect(markerBytes.length).toBe(4);
    const markerByteIdx = Buffer.from(text, 'utf8').indexOf(markerBytes);
    const [chunk1, chunk2] = splitIntoChunks(text, markerByteIdx + 2); // split inside the 4-byte sequence

    // The buggy approach: `buffer += chunk.toString()` per chunk.
    const buggyResult = chunk1.toString('utf8') + chunk2.toString('utf8');

    // Each half decodes independently, so the split character is corrupted —
    // this is exactly the "garbled" artifact users see.
    expect(buggyResult).not.toBe(text);
    expect(buggyResult).toContain('\uFFFD');
  });

  it('fixes the bug: StringDecoder reassembles a character split across chunks', () => {
    const text = `hello ${EMOJI} world`;
    const markerBytes = Buffer.from(EMOJI, 'utf8');
    const markerByteIdx = Buffer.from(text, 'utf8').indexOf(markerBytes);
    const [chunk1, chunk2] = splitIntoChunks(text, markerByteIdx + 2);

    const decoder = new StringDecoder('utf8');
    const fixedResult = decoder.write(chunk1) + decoder.write(chunk2);

    expect(fixedResult).toBe(text);
    expect(fixedResult).not.toContain('\uFFFD');
  });

  it('fixes the bug for a 3-byte CJK character split at every possible byte boundary', () => {
    const text = `status: ${CJK} ok`;
    const markerBytes = Buffer.from(CJK, 'utf8');
    expect(markerBytes.length).toBe(3);
    const full = Buffer.from(text, 'utf8');
    const markerByteIdx = full.indexOf(markerBytes);

    for (let offset = 1; offset < 3; offset++) {
      const [chunk1, chunk2] = splitIntoChunks(text, markerByteIdx + offset);
      const decoder = new StringDecoder('utf8');
      const result = decoder.write(chunk1) + decoder.write(chunk2);
      expect(result).toBe(text);
    }
  });

  it('handles many small chunks (simulating a slow/fragmented socket read)', () => {
    const text = `${CJK}${EMOJI}${CJK} mixed ${EMOJI} stream`;
    const full = Buffer.from(text, 'utf8');
    const decoder = new StringDecoder('utf8');
    let result = '';
    // Feed one byte at a time — the worst case for chunk-boundary splitting.
    for (let i = 0; i < full.length; i++) {
      result += decoder.write(full.subarray(i, i + 1));
    }
    result += decoder.end();
    expect(result).toBe(text);
  });
});
