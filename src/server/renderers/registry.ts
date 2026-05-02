export type RendererFn = (rawOutput: string) => string;

const registry = new Map<string, RendererFn>();

export function registerRenderer(type: string, fn: RendererFn): void {
  registry.set(type, fn);
}

export function render(type: string, rawOutput: string): string {
  const fn = registry.get(type);
  if (!fn) {
    console.warn(`[renderer] Unknown renderer type "${type}", falling back to plaintext`);
    return rawOutput;
  }
  return fn(rawOutput);
}

export function getRendererTypes(): string[] {
  return Array.from(registry.keys());
}
