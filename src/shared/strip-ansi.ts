/**
 * Strip ANSI escape sequences and normalize PTY output.
 *
 * Covers CSI sequences (colors, cursor movement, erase),
 * OSC sequences (terminal titles, hyperlinks), and simple
 * two-character escapes.
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Normalize raw PTY output for storage/display:
 * 1. Strip ANSI escape sequences
 * 2. Normalize \r\n → \n
 * 3. Replace lone \r (carriage return without \n) with \n
 * 4. Strip remaining control characters except \n and \t
 */
export function normalizePtyOutput(raw: string): string {
  let text = stripAnsi(raw);
  // Normalize Windows-style line endings
  text = text.replace(/\r\n/g, '\n');
  // Replace orphan carriage returns with newlines
  text = text.replace(/\r/g, '\n');
  // Remove other control characters (keep \n=0x0A, \t=0x09)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return text;
}
