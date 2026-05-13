/**
 * Stream-safe terminal output filter.
 *
 * Filters out known noise lines (e.g. internal Copilot CLI errors) while
 * preserving the raw byte stream — ANSI codes, cursor movement, and all.
 *
 * Design:
 * - Splits incoming chunks on line boundaries (\r\n or \n).
 * - Complete lines are checked against filter patterns (ANSI-stripped).
 * - Matched lines (+ their line ending) are silently dropped.
 * - Unmatched lines pass through verbatim (ANSI intact).
 * - An incomplete trailing fragment is held in a buffer until the next
 *   chunk arrives or a flush timeout fires (default 150 ms) so interactive
 *   prompts aren't delayed.
 */

import { stripAnsi } from './strip-ansi';

export interface OutputFilterOptions {
  /** Patterns to match against ANSI-stripped line text. */
  patterns: RegExp[];
  /** Max ms to hold an incomplete line before flushing (default 150). */
  flushTimeoutMs?: number;
}

/** Default patterns: known Copilot CLI internal errors. */
export const DEFAULT_FILTER_PATTERNS: RegExp[] = [
  // "✗ TypeError: Cannot read properties of undefined (reading 'forEach')"
  /^✗?\s*TypeError: Cannot read properties of undefined/,
  // Broader: any single-line JS TypeError from the CLI runtime
  /^✗?\s*TypeError: Cannot read properties of (undefined|null)/,
];

export class OutputFilter {
  private patterns: RegExp[];
  private flushMs: number;
  private pending = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: ((data: string) => void) | null = null;

  constructor(opts: OutputFilterOptions) {
    this.patterns = opts.patterns;
    this.flushMs = opts.flushTimeoutMs ?? 150;
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
   * Filtered output is delivered synchronously via the `onFlush` callback
   * for complete lines, or asynchronously after the flush timeout for
   * trailing fragments.
   */
  push(chunk: string): void {
    this.cancelFlushTimer();

    const input = this.pending + chunk;
    this.pending = '';

    // Split on line boundaries while keeping the delimiters.
    // Groups: (line content)(line ending) or trailing fragment.
    const parts = input.split(/(\r?\n)/);

    let out = '';

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];

      // Line-ending tokens (\n or \r\n) are always attached to the
      // preceding segment — they never appear as the first element.
      const isLineEnding = segment === '\n' || segment === '\r\n';
      if (isLineEnding) continue; // handled below when we process the preceding segment

      const lineEnding = parts[i + 1] ?? '';
      const hasLineEnding = lineEnding === '\n' || lineEnding === '\r\n';

      if (hasLineEnding) {
        // Complete line — check against filters
        const stripped = stripAnsi(segment).trim();
        if (this.shouldFilter(stripped)) {
          // Drop the line and its ending
          i++; // skip the line-ending token
          continue;
        }
        out += segment + lineEnding;
        i++; // skip the line-ending token
      } else {
        // Trailing fragment (no line ending yet)
        this.pending = segment;
      }
    }

    if (out) {
      this.onFlush?.(out);
    }

    // If there's a pending fragment, schedule a flush so interactive
    // prompts aren't held indefinitely.
    if (this.pending) {
      this.startFlushTimer();
    }
  }

  /** Force-flush any buffered fragment immediately. */
  flush(): void {
    this.cancelFlushTimer();
    if (this.pending) {
      this.onFlush?.(this.pending);
      this.pending = '';
    }
  }

  /** Clean up timers. Call when the terminal is disposed. */
  dispose(): void {
    this.cancelFlushTimer();
    this.pending = '';
  }

  private shouldFilter(stripped: string): boolean {
    if (!stripped) return false;
    return this.patterns.some((re) => re.test(stripped));
  }

  private startFlushTimer(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pending) {
        this.onFlush?.(this.pending);
        this.pending = '';
      }
    }, this.flushMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
