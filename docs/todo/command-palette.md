# Command Palette

## Overview
A Ctrl+K searchable command palette for quick access to actions, navigation, and settings — similar to VS Code's command palette.

## Features
- Fuzzy search across all available actions
- Categories: navigation, project switch, tab management, theme, settings
- Recent actions shown by default
- Keyboard-driven (arrow keys + enter to select)
- Extensible action registry for plugins/skills

## Implementation Notes
- Global keydown listener for Ctrl+K
- Overlay modal with search input and filtered action list
- Action registry pattern: each feature registers its commands
- Use a lightweight fuzzy search library (e.g., fuse.js)
