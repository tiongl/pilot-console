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
├── daemon/      # Session daemon (PTY + agent runtime, survives server restarts)
├── shared/      # Shared modules (cli-bridge, types)
└── test/        # Vitest tests
```

The **session daemon** is a standalone process that owns all PTY sessions. It communicates with the Express server over a named pipe (Windows) or Unix domain socket (Linux/macOS). This means terminal sessions survive server restarts.

The daemon also hosts the **Copilot SDK runtime** for agent-mode sessions. It starts the runtime lazily on first use, listening on a loopback TCP port, and publishes the connection details to `~/.pilot-console/agent-runtime.json` (mode `0600`). The Express server attaches to that runtime with `RuntimeConnection.forUri`, which does not spawn a process — so stopping or restarting the server leaves the runtime itself untouched, and re-attaching is immediate. On restart the server resumes each session with `continuePendingWork`, which replays any permission prompt raised while nobody was listening (auto-approved if that session had "allow all" enabled). If the daemon is unavailable the server falls back to spawning an in-process runtime.

Conversation state is persisted by the SDK itself, in `~/.copilot/session-store.db` (shared with the Copilot CLI), so session history survives even a full runtime restart. **In-flight work is not durable**, however: the runtime shuts a session down when its owning client disconnects, so a turn that is mid-flight when the server restarts is aborted rather than resumed. Closing that gap requires moving the sessions themselves into the daemon and reducing the server to a thin proxy — a planned follow-up.
