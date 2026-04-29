#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const pkgDir = path.resolve(__dirname, '..');

// Ensure the config directory exists
const configDir = path.join(os.homedir(), '.clippy');
fs.mkdirSync(configDir, { recursive: true });

// Check if we have a production client build
const hasClientBuild = fs.existsSync(path.join(pkgDir, 'dist', 'client', 'index.html'));
process.env.NODE_ENV = hasClientBuild ? 'production' : 'development';

// Register tsx for TypeScript support and start the Express server
require('tsx/cjs');
require('../src/server/index.ts');
