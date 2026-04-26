# GCClippy

A GitHub Copilot CLI session manager with a web dashboard.

## Installation (Windows)

Run the installer script:

```powershell
irm https://raw.githubusercontent.com/tionglee_microsoft/gcclippy/main/scripts/install.ps1 | iex
```

Or manually:

```powershell
git clone https://github.com/tionglee_microsoft/gcclippy.git ~/.gcclippy/app
cd ~/.gcclippy/app
npm install
npm link
```

> **Note:** `npm install -g "github:..."` does not work on Windows due to
> [Next.js symlink issues](https://github.com/vercel/next.js/issues) in
> npm's tar extraction. Use the installer script above instead.

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
