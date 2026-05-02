import { registerRenderer } from './registry';

// Plaintext: identity transform
registerRenderer('plaintext', (raw) => raw);

// Markdown: pass through (client renders with react-markdown)
registerRenderer('markdown', (raw) => raw);

// HTML: pass through (client renders in sandboxed iframe or dangerouslySetInnerHTML)
registerRenderer('html', (raw) => raw);

// JSON: attempt to extract and pretty-print JSON blocks from output
registerRenderer('json', (raw) => {
  // Try parsing the entire output as JSON first
  try {
    const parsed = JSON.parse(raw.trim());
    return JSON.stringify(parsed, null, 2);
  } catch {
    // Fall through
  }

  // Try to find JSON blocks in the output (```json ... ``` or { ... })
  const jsonBlocks: string[] = [];
  const fencedRegex = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fencedRegex.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      jsonBlocks.push(JSON.stringify(parsed, null, 2));
    } catch {
      jsonBlocks.push(match[1].trim());
    }
  }

  if (jsonBlocks.length > 0) {
    return jsonBlocks.join('\n\n---\n\n');
  }

  // Try to find bare JSON objects/arrays
  const braceRegex = /(\{[\s\S]*\}|\[[\s\S]*\])/g;
  while ((match = braceRegex.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      jsonBlocks.push(JSON.stringify(parsed, null, 2));
    } catch {
      // Not valid JSON, skip
    }
  }

  return jsonBlocks.length > 0 ? jsonBlocks.join('\n\n---\n\n') : raw;
});
