import { defineConfig } from 'tsup';

/**
 * Builds the server and daemon TypeScript into runnable CommonJS so the
 * published package does not depend on `tsx` at runtime. Third-party
 * dependencies are kept external and resolved from node_modules at runtime;
 * native addons (better-sqlite3, node-pty) must stay external. `uuid` ships as
 * ESM-only, so it is bundled inline and down-compiled to CJS.
 */
export default defineConfig({
  entry: {
    'server/index': 'src/server/index.ts',
    'daemon/index': 'src/daemon/index.ts',
  },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  shims: false,
  noExternal: ['uuid'],
  external: ['better-sqlite3', 'node-pty'],
});
