#!/usr/bin/env node
// Reusable docs screenshot capture.
//
//   npm run docs:screens                 # capture every shot in shots.mjs
//   npm run docs:screens -- --only login,project-settings
//   npm run docs:screens -- --base-url http://localhost:5173
//   npm run docs:screens -- --theme dark --width 1440 --height 900
//
// The script mocks the backend (see fixtures.mjs) so it needs no GitHub CLI
// auth, no daemon, and no seeded data. If no server is reachable at the base
// URL it starts `npm run dev` automatically and shuts it down when finished.
//
// Output: docs/user-guide/images/<name>.png plus images/manifest.json.

import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installApiMocks } from './fixtures.mjs';
import { shots as ALL_SHOTS } from './shots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'user-guide', 'images');

function parseArgs(argv) {
  const args = { width: 1440, height: 900, theme: 'dark', waitMs: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--only') args.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--base-url') args.baseUrl = next();
    else if (a === '--theme') args.theme = next();
    else if (a === '--width') args.width = Number(next());
    else if (a === '--height') args.height = Number(next());
    else if (a === '--wait') args.waitMs = Number(next());
    else if (a === '--no-server') args.noServer = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Capture docs screenshots.

Options:
  --only <names>     Comma-separated shot names to capture (default: all).
  --base-url <url>   Server to shoot against (default: auto-detect 5173/3001, else start dev).
  --theme <t>        'dark' | 'light' default theme (default: dark).
  --width <px>       Viewport width (default: 1440).
  --height <px>      Viewport height (default: 900).
  --wait <ms>        Default settle delay per shot (default: 600).
  --no-server        Never start a server; fail if base URL is unreachable.
  -h, --help         Show this help.
`);
}

async function isUp(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}

async function detectBaseUrl() {
  for (const url of ['http://localhost:5173', 'http://localhost:3001']) {
    if (await isUp(url)) return url;
  }
  return null;
}

async function startDevServer() {
  console.log('· No server detected — starting `npm run dev`…');
  const isWin = process.platform === 'win32';
  const proc = spawn('npm', ['run', 'dev'], {
    cwd: REPO_ROOT, stdio: 'ignore', shell: true, detached: !isWin,
  });
  const url = 'http://localhost:5173';
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await isUp(url)) {
      console.log(`· Dev server is up at ${url}`);
      return { url, proc };
    }
    await sleep(1000);
  }
  stopDevServer(proc);
  throw new Error('Dev server did not become ready within 90s.');
}

function stopDevServer(proc) {
  if (!proc || proc.killed) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(-proc.pid);
    }
  } catch {
    try { proc.kill(); } catch { /* ignore */ }
  }
}

async function runActions(page, actions = []) {
  for (const step of actions) {
    if (step.click) await clickTarget(page, step.click);
    else if (step.fill) await page.fill(step.fill, step.value ?? '');
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.waitFor) await waitTarget(page, step.waitFor);
    else if (step.wait) await sleep(step.wait);
  }
}

function looksLikeSelector(s) {
  return /^[.#\[]/.test(s) || /[>:]/.test(s) || /^[a-z]+\[/.test(s);
}

async function clickTarget(page, target) {
  if (looksLikeSelector(target)) await page.click(target);
  else await page.getByText(target, { exact: false }).first().click();
}

async function waitTarget(page, target) {
  if (looksLikeSelector(target)) await page.waitForSelector(target, { timeout: 15_000 });
  else await page.getByText(target, { exact: false }).first().waitFor({ timeout: 15_000 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  let shots = ALL_SHOTS;
  if (args.only) {
    const set = new Set(args.only);
    shots = ALL_SHOTS.filter((s) => set.has(s.name));
    const missing = args.only.filter((n) => !ALL_SHOTS.some((s) => s.name === n));
    if (missing.length) console.warn(`! Unknown shot(s): ${missing.join(', ')}`);
  }
  if (!shots.length) { console.error('No shots to capture.'); process.exit(1); }

  await mkdir(OUT_DIR, { recursive: true });

  let baseUrl = args.baseUrl ?? (await detectBaseUrl());
  let serverProc = null;
  if (!baseUrl) {
    if (args.noServer) { console.error('No server reachable and --no-server set.'); process.exit(1); }
    const started = await startDevServer();
    baseUrl = started.url;
    serverProc = started.proc;
  } else {
    console.log(`· Using server at ${baseUrl}`);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 2,
  });
  await installApiMocks(context);

  // Seed a default UI theme (and terminal theme) before any app code runs.
  const defaultTheme = args.theme;
  await context.addInitScript((t) => {
    try { window.localStorage.setItem('pilot-console-ui-theme', t); } catch { /* ignore */ }
  }, defaultTheme);

  const captured = [];
  const failures = [];
  const consoleErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  for (const shot of shots) {
    const vp = shot.viewport ?? { width: args.width, height: args.height };
    await page.setViewportSize(vp);

    const file = path.join(OUT_DIR, `${shot.name}.png`);
    try {
      consoleErrors.length = 0;
      await page.goto(baseUrl + shot.route, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Per-shot theme override: set and reload so the app picks it up.
      if (shot.theme && shot.theme !== defaultTheme) {
        await page.evaluate((t) => window.localStorage.setItem('pilot-console-ui-theme', t), shot.theme);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      }
      if (shot.waitFor) await waitTarget(page, shot.waitFor);
      await runActions(page, shot.actions);
      await sleep(shot.waitMs ?? args.waitMs);
      await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
      captured.push({ name: shot.name, route: shot.route, caption: shot.caption, file: path.relative(REPO_ROOT, file) });
      const warn = consoleErrors.length ? `  (⚠ ${consoleErrors.length} page error(s))` : '';
      console.log(`✓ ${shot.name} → ${path.relative(REPO_ROOT, file)}${warn}`);
    } catch (err) {
      failures.push({ name: shot.name, error: String(err) });
      console.error(`✗ ${shot.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  await writeFile(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, shots: captured }, null, 2),
  );

  await browser.close();
  if (serverProc) stopDevServer(serverProc);

  console.log(`\nCaptured ${captured.length}/${shots.length} screenshot(s) into ${path.relative(REPO_ROOT, OUT_DIR)}.`);
  if (failures.length) { console.error(`${failures.length} failed.`); process.exitCode = 1; }
}

main().catch((err) => { console.error(err); process.exit(1); });
