#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const pkgDir = path.resolve(__dirname, '..');
const hasNextBuild = fs.existsSync(path.join(pkgDir, '.next'));

// Use production mode only if .next build exists; otherwise fall back to dev
process.env.NODE_ENV = hasNextBuild ? 'production' : 'development';

// Auto-generate AUTH_SECRET / NEXTAUTH_SECRET if not set
const configDir = path.join(os.homedir(), '.gcclippy');
const secretFile = path.join(configDir, '.secret');

if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
  fs.mkdirSync(configDir, { recursive: true });
  let secret;
  if (fs.existsSync(secretFile)) {
    secret = fs.readFileSync(secretFile, 'utf-8').trim();
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
  process.env.AUTH_SECRET = secret;
  process.env.NEXTAUTH_SECRET = secret;
}

import('tsx/esm/api').then(({ register }) => {
  register();
  import('../server.ts');
});
