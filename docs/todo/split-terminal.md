# Split Terminal

## Overview
Side-by-side terminal panes within a single project tab, allowing users to run Copilot in one pane and a shell in another simultaneously.

## Features
- Horizontal and vertical split within the terminal area
- Each pane is an independent terminal (own session, own WS connection)
- Drag-to-resize divider
- Keyboard shortcuts to split, navigate between panes, and close
- Persist split layout across tab switches

## Implementation Notes
- Reuse TerminalTab component per pane
- Layout state managed in ProjectChatPage
- CSS grid or flexbox with a draggable resizer
