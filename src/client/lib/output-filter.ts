/**
 * Stream-safe terminal output filter.
 *
 * Filters out known noise lines (e.g. internal Copilot CLI errors) while
 * preserving the raw byte stream — ANSI codes, cursor movement, and all.
 *
 * Two strategies depending on the output type:
 *
 * 1. **Line-oriented output** — lines matching a pattern are dropped entirely.
 * 2. **TUI output** (contains cursor-positioning sequences like \x1b[5;1H) —
 *    matching text is **redacted** in-place (replaced with spaces) so that
 *    cursor positioning remains intact and the stream is not corrupted.
 *
 * Zero-latency: no buffering, no timers, no typing lag.
 */

import { stripAnsi } from './strip-ansi';

export interface OutputFilterOptions {
  /** Patterns to match against ANSI-stripped line text. */
  patterns: RegExp[];
}

/** Default patterns: known Copilot CLI internal errors. */
export const DEFAULT_FILTER_PATTERNS: RegExp[] = [
  /TypeError: Cannot read properties of (undefined|null)/,
];

/**
 * Patterns to match the raw text portions we want to redact in TUI mode.
 * These target the visible text (between ANSI sequences) so we can replace
 * it with spaces while keeping escape codes intact.
 */
const REDACT_RAW_PATTERNS: RegExp[] = [
  // The ✗ marker followed by the error text (with ANSI codes between)
  // We match the visible characters around the ANSI codes
  /✗/g,
  /TypeError: Cannot read properties of (?:undefined|null) \(reading '[^']*'\)/g,
];

/** Detect cursor-positioning sequences: \x1b[H or \x1b[<row>;<col>H */
const CURSOR_POS_RE = /\x1b\[\d*;?\d*H/;

export class OutputFilter {
  private patterns: RegExp[];
  private onFlush: ((data: string) => void) | null = null;

  constructor(opts: OutputFilterOptions) {
    this.patterns = opts.patterns;
  }

  /**
   * Set the callback that receives filtered output.
   * Must be called before `push()`.
   */
  setOutput(fn: (data: string) => void) {
    this.onFlush = fn;
  }

  /**
   * Feed raw terminal data into the filter.
   */
  push(chunk: string): void {
    if (!chunk) return;

    // Check if any pattern matches (using stripped text)
    const stripped = stripAnsi(chunk);
    if (!this.shouldFilter(stripped)) {
      // No matches — pass through untouched
      this.onFlush?.(chunk);
      return;
    }

    // The chunk matches a filter pattern.
    // Strategy depends on whether this is TUI output (cursor-positioned)
    // or simple line-oriented output.

    if (CURSOR_POS_RE.test(chunk)) {
      // TUI mode: redact matching text in-place to preserve cursor positioning.
      // We walk the raw string, replacing visible text that matches while
      // keeping all ANSI escape sequences intact.
      const redacted = this.redactInPlace(chunk);
      this.onFlush?.(redacted);
      return;
    }

    // Line-oriented mode: drop matching lines entirely.
    this.filterLines(chunk);
  }

  /** No-op — kept for API compatibility. */
  flush(): void {}

  /** No-op — kept for API compatibility. */
  dispose(): void {}

  /**
   * Redact matching visible text by replacing it with spaces.
   * ANSI escape sequences are preserved so cursor positioning stays intact.
   */
  private redactInPlace(chunk: string): string {
    // Extract visible text (strip ANSI), find match positions, then
    // map those positions back to the raw string to blank them out.
    //
    // Approach: split raw string into [escape, text, escape, text, ...] tokens.
    // For each text token, replace matching substrings with spaces.
    const ANSI_RE = /(\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\].*?\x1b\\))/;
    const tokens = chunk.split(ANSI_RE);

    for (let i = 0; i < tokens.length; i++) {
      // ANSI tokens match the regex — skip them
      if (ANSI_RE.test(tokens[i])) continue;

      // This is a visible text token — redact matching content
      for (const pat of REDACT_RAW_PATTERNS) {
        const re = new RegExp(pat.source, pat.flags);
        tokens[i] = tokens[i].replace(re, (m) => ' '.repeat(m.length));
      }
    }

    return tokens.join('');
  }

  /**
   * Line-oriented filtering: drop complete lines that match.
   */
  private filterLines(chunk: string): void {
    if (!chunk.includes('\n')) {
      // No line endings — check fragment
      const s = stripAnsi(chunk).trim();
      if (s && this.shouldFilter(s)) return; // drop
      this.onFlush?.(chunk);
      return;
    }

    const parts = chunk.split(/(\r?\n)/);
    let out = '';

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      if (segment === '\n' || segment === '\r\n') continue;

      const lineEnding = parts[i + 1] ?? '';
      const hasLineEnding = lineEnding === '\n' || lineEnding === '\r\n';

      if (hasLineEnding) {
        const s = stripAnsi(segment).trim();
        if (this.shouldFilter(s)) {
          i++;
          continue;
        }
        out += segment + lineEnding;
        i++;
      } else {
        const s = stripAnsi(segment).trim();
        if (s && this.shouldFilter(s)) continue;
        out += segment;
      }
    }

    if (out) this.onFlush?.(out);
  }

  private shouldFilter(stripped: string): boolean {
    if (!stripped) return false;
    return this.patterns.some((re) => re.test(stripped));
  }
}
