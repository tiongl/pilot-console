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

/** Default patterns: known Copilot CLI internal errors. */
export const DEFAULT_FILTER_PATTERNS: RegExp[] = [
  // "✗ TypeError: Cannot read properties of undefined (reading 'forEach')"
  /^✗?\s*TypeError: Cannot read properties of undefined/,
  // Broader: any single-line JS TypeError from the CLI runtime
  /^✗?\s*TypeError: Cannot read properties of (undefined|null)/,
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

    // Fast path: if no line endings at all, pass through immediately
    if (!chunk.includes('\n')) {
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
        // Trailing fragment — pass through immediately (no buffering)
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
