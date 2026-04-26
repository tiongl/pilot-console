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
> postinstall script issues with native dependencies (esbuild, better-sqlite3).
> Use the clone-based methods above instead.

## Usage

```bash
clippy
```

This starts the web dashboard at [http://localhost:3001](http://localhost:3001).

## Development

```bash
npm run dev
```

Opens Vite dev server at [http://localhost:5173](http://localhost:5173) with HMR, proxying API calls to the Express backend on port 3001.
