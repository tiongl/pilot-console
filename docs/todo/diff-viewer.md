# Side-by-Side Diff Viewer

## Overview
Syntax-highlighted side-by-side diff viewer using Monaco editor, replacing the plain-text diff currently shown in GitPanel.

## Features
- Side-by-side and inline diff modes
- Syntax highlighting based on file extension
- Line-level navigation (next/prev change)
- Staged vs unstaged toggle
- Commit-to-commit comparison

## Implementation Notes
- Monaco's `createDiffEditor` API handles side-by-side rendering
- MonacoFileEditor component already exists — extend or wrap it
- Feed original and modified content from `git show` and working tree
