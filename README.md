# GCClippy

A GitHub Copilot CLI session manager with a web dashboard.

## Installation (Windows)

**Option 1 — One-liner** (requires [GitHub CLI](https://cli.github.com/)):

```powershell
gh repo clone tionglee_microsoft/gcclippy ~/.gcclippy/app && cd ~/.gcclippy/app && npm install && npm link
```

**Option 2 — Installer script** (from a local clone):

```powershell
.\scripts\install.ps1
```

**Option 3 — Manual:**

```powershell
git clone https://github.com/tionglee_microsoft/gcclippy.git ~/.gcclippy/app
cd ~/.gcclippy/app
npm install
npm link
```

> **Note:** `npm install -g "github:..."` does not work on Windows due to
> Next.js symlink issues in npm's tar extraction. Use the methods above instead.

## Usage

```bash
clippy
```

This starts the web dashboard at [http://localhost:3000](http://localhost:3000).

## Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — the page auto-updates as you edit files.
