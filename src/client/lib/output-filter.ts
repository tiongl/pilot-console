/**
 * Stream-safe terminal output filter.
 *
 * Filters out known noise lines (e.g. internal Copilot CLI errors) while
 * preserving the raw byte stream — ANSI codes, cursor movement, and all.
 *
 * **Zero-latency design**: only complete lines are inspected. Incomplete
 * trailing fragments pass through immediately — no buffering, no timers,
 * no typing lag. The trade-off is that a filtered line split across two
 * WS chunks won't be caught, but that's rare and cosmetic.
 */

import { stripAnsi } from './strip-ansi';

export interface OutputFilterOptions {
  /** Patterns to match against ANSI-stripped line text. */
  patterns: RegExp[];
}

/** Convert a string to a hex dump for debugging terminal escape sequences */
function hexDump(s: string): string {
  return Array.from(s).map(c => {
    const code = c.charCodeAt(0);
    if (code >= 0x20 && code < 0x7F) return c;
    if (code < 0x100) return `\\x${code.toString(16).padStart(2, '0')}`;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }).join('');
}

/** Default patterns: known Copilot CLI internal errors. */
export const DEFAULT_FILTER_PATTERNS: RegExp[] = [
  // Match the error anywhere in the line (not just at start) to handle
  // cursor movement / ANSI prefixes that leave leading content
  /TypeError: Cannot read properties of (undefined|null)/,
];

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
   * Complete lines are checked against patterns; everything else passes
   * through synchronously with zero delay.
   */
  push(chunk: string): void {
    if (!chunk) return;

    // Diagnostic: log raw hex when "TypeError" appears anywhere in the chunk
    // so we can see exactly what bytes the CLI sends.
    if (chunk.includes('TypeError')) {
      console.warn('[OutputFilter] TypeError detected in chunk. Raw hex:', hexDump(chunk));
      console.warn('[OutputFilter] Stripped:', stripAnsi(chunk));
      console.warn('[OutputFilter] Has newline:', chunk.includes('\n'));
    }

    // Fast path: if no line endings at all, check for filter matches
    // even on fragments (the error may arrive without a trailing newline)
    if (!chunk.includes('\n')) {
      const stripped = stripAnsi(chunk).trim();
      if (stripped && this.shouldFilter(stripped)) {
        console.warn('[OutputFilter] Filtered fragment (no newline):', hexDump(chunk));
        return; // drop it
      }
      this.onFlush?.(chunk);
      return;
    }

    // Split on line boundaries while keeping the delimiters.
    const parts = chunk.split(/(\r?\n)/);

    let out = '';

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];

      // Line-ending tokens (\n or \r\n) — skip, handled with preceding segment
      if (segment === '\n' || segment === '\r\n') continue;

      const lineEnding = parts[i + 1] ?? '';
      const hasLineEnding = lineEnding === '\n' || lineEnding === '\r\n';

      if (hasLineEnding) {
        // Complete line — check against filters
        const stripped = stripAnsi(segment).trim();
        if (this.shouldFilter(stripped)) {
          i++; // skip the line-ending token
          continue;
        }
        out += segment + lineEnding;
        i++; // skip the line-ending token
      } else {
        // Trailing fragment — also check against filters
        const stripped = stripAnsi(segment).trim();
        if (stripped && this.shouldFilter(stripped)) {
          continue; // drop it
        }
        out += segment;
      }
    }

    if (out) {
      this.onFlush?.(out);
    }
  }

  /** No-op — kept for API compatibility. */
  flush(): void {}

  /** No-op — kept for API compatibility. */
  dispose(): void {}

  private shouldFilter(stripped: string): boolean {
    if (!stripped) return false;
    return this.patterns.some((re) => re.test(stripped));
  }
}
