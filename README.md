# Pilot Console

A GitHub Copilot CLI session manager with a web dashboard.

## Features
![pilot-console features](screenshot.png "Features")

## Prerequisites

- **Node.js** ≥ 20
- **npm** ≥ 9
- **Git**
- **GitHub CLI** (`gh`) — required for Copilot CLI sessions ([install](https://cli.github.com/))
- A C/C++ toolchain for native modules (`node-pty`, `better-sqlite3`):
  - **Windows:** `npm install -g windows-build-tools` or install Visual Studio Build Tools
  - **Linux:** `sudo apt install build-essential python3` (Debian/Ubuntu) or equivalent

## Installation

### Linux / macOS

**One-liner** (install or update):

```bash
cd ~/.pilot-console/app 2>/dev/null && git pull --ff-only || gh repo clone tiongl/clippy ~/.pilot-console/app && cd ~/.pilot-console/app && npm install && npm link
```

### Windows

**One-liner** (PowerShell, install or update):

```powershell
if (Test-Path $HOME\.pilot-console\app) { cd $HOME\.pilot-console\app; git pull --ff-only } else { gh repo clone tiongl/clippy $HOME\.pilot-console\app; cd $HOME\.pilot-console\app }; npm install; npm link
```

**Installer script** (from a local clone, handles re-installs):

```powershell
.\scripts\install.ps1
```

> **Note:** `npm install -g "github:..."` does not work on Windows due to
> postinstall script issues with native dependencies (esbuild, better-sqlite3).
> Use the clone-based methods above instead.

## Usage

```bash
pilot-console
```

This starts the web dashboard at [http://localhost:3001](http://localhost:3001).

On first launch a default admin account is created — check the terminal output for credentials.

> **Important:** Pilot Console runs a **background daemon** process that manages terminal sessions.
> The daemon keeps running even if you navigate away from the browser.
> To fully shut down Pilot Console, **close the terminal window** where you ran the `pilot-console` command (or press `Ctrl+C` in that terminal).

## Development

```bash
npm run dev
```

Opens Vite dev server at [http://localhost:5173](http://localhost:5173) with HMR, proxying API calls to the Express backend on port 3001.

### Useful commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (client + API with HMR) |
| `npm run build` | Production client build |
| `npm start` | Start production server |
| `npm test` | Run tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run daemon` | Start the session daemon standalone |

## Architecture

```
src/
├── client/      # React SPA (Vite)
├── server/      # Express API + WebSocket server
├── daemon/      # Session daemon (PTY lifecycle, survives server restarts)
├── shared/      # Shared modules (cli-bridge, types)
└── test/        # Vitest tests
```

The **session daemon** is a standalone process that owns all PTY sessions. It communicates with the Express server over a named pipe (Windows) or Unix domain socket (Linux/macOS). This means terminal sessions survive server restarts.
