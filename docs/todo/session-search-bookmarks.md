# Session Search & Bookmarks

## Overview
Full-text search across past Copilot session transcripts with the ability to bookmark useful conversations for quick access.

## Features
- Search bar in Sessions page that queries transcript content (not just session names)
- SQLite FTS5 virtual table for fast full-text indexing of session output
- Bookmark/star individual sessions for quick access
- Filter by project, date range, and bookmark status
- Search result highlighting with context snippets

## Implementation Notes
- Add FTS5 table mirroring `cli_sessions.output_log`
- Rebuild index on demand or incrementally on session end
- Bookmarks stored as a boolean column on `cli_sessions`
