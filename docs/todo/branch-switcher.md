# Branch Switcher

## Overview
Switch git branches from the UI without opening a shell tab — quick branch management directly from the project sidebar or git panel.

## Features
- Dropdown listing local and remote branches
- One-click checkout with dirty-state warning
- Create new branch from current HEAD
- Delete merged branches
- Shows ahead/behind counts relative to remote

## Implementation Notes
- New API endpoints: `GET /api/projects/:id/branches`, `POST /api/projects/:id/checkout`
- Use async `git branch -a`, `git checkout`, `git switch`
- Broadcast `git-changed` event after checkout so UI refreshes
