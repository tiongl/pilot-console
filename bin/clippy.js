#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const pkgDir = path.resolve(__dirname, '..');

// Use production mode only if a production build exists
const hasProductionBuild = fs.existsSync(path.join(pkgDir, '.next', 'BUILD_ID'));
process.env.NODE_ENV = hasProductionBuild ? 'production' : 'development';

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

// Register tsx for TypeScript support and load the server
require('tsx/cjs');
require('../server.ts');
