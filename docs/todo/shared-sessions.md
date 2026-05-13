# Shared Sessions

## Overview
Read-only live view of another user's terminal session — useful for pair programming, demos, and debugging assistance.

## Features
- Share button on active session generates a shareable link
- Viewers see real-time terminal output (read-only)
- Host can revoke access at any time
- Viewer count indicator for the host
- Optional chat sidebar for communication

## Implementation Notes
- New WS connection mode: `?share=true&token=<shareToken>`
- Share tokens stored in DB with expiry and session binding
- Server broadcasts output to share viewers (same as main WS but read-only)
- Rate limit share connections per session
