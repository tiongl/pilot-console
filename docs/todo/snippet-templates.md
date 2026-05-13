# Snippets & Prompt Templates

## Overview
Quick-insert prompt templates that users can save, organize, and reuse across projects. The snippets API exists but needs a richer UI and per-project scoping.

## Features
- Create/edit/delete prompt snippets with title, body, and optional category
- Per-project and global scopes
- Quick-insert from terminal tab via keyboard shortcut or dropdown
- Variable interpolation (e.g., `{{branch}}`, `{{project}}`)
- Import/export snippets as JSON

## Implementation Notes
- Extend existing `/api/snippets` endpoints with project scoping
- Add a snippet picker dropdown in the terminal tab bar
- Store variables as mustache-style placeholders, resolve at insert time
