#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const pkgDir = path.resolve(__dirname, '..');

// Ensure the config directory exists
const configDir = path.join(os.homedir(), '.pilot-console');
fs.mkdirSync(configDir, { recursive: true });

// Prefer the compiled server (shipped in published packages). Fall back to
// running the TypeScript source via tsx for local development checkouts where
// the build has not been produced yet.
const compiledServer = path.join(pkgDir, 'dist', 'server', 'index.js');
const hasCompiledServer = fs.existsSync(compiledServer);

// Check if we have a production client build
const hasClientBuild = fs.existsSync(path.join(pkgDir, 'dist', 'client', 'index.html'));
process.env.NODE_ENV = hasClientBuild ? 'production' : 'development';

if (hasCompiledServer) {
  require(compiledServer);
} else {
  // Development fallback: run the TypeScript source directly.
  require('tsx/cjs');
  require('../src/server/index.ts');
}
