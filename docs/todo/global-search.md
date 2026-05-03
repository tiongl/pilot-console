# TODO: Global Search

**Status: NOT STARTED** — No way to search across sessions, reports, or projects from a single place.

## Summary

Add a unified search bar to the dashboard that searches across session transcripts, automation report outputs, and project names/descriptions.

## Tasks

### 1. Backend: Search endpoint
- `GET /api/search?q=<query>&scope=all|sessions|reports|projects`
- Full-text search across:
  - Session transcripts (from `~/.copilot/session-store.db`)
  - Automation report outputs (`report_runs.raw_output`, `rendered_output`)
  - Project names and descriptions
- Return results grouped by type with snippets
- **Files**: `src/server/index.ts`, `src/shared/session-store.ts`, `src/shared/schedule-store.ts`

### 2. Frontend: Search bar in header
- Add a search input to `DashboardLayout` header
- Keyboard shortcut: `Ctrl+K` / `Cmd+K` to focus
- Show results in a dropdown/overlay grouped by type
- Click result to navigate to the relevant page
- **Files**: `src/client/pages/DashboardLayout.tsx`

### 3. Frontend: Search results page (optional)
- Full-page search results for complex queries
- Filters by type, date range
- **File**: new `src/client/pages/SearchPage.tsx`

## Considerations

- SQLite FTS5 could be used for efficient full-text search on large datasets
- Start with simple `LIKE` queries, upgrade to FTS5 if performance is an issue
- Session transcripts live in a separate DB (`~/.copilot/session-store.db`) — need cross-DB search

## File Changes

| File | Change |
|------|--------|
| `src/server/index.ts` | Search endpoint |
| `src/shared/session-store.ts` | Transcript search method |
| `src/shared/schedule-store.ts` | Report output search method |
| `src/client/pages/DashboardLayout.tsx` | Search bar + results dropdown |
| `src/client/pages/SearchPage.tsx` | Optional full results page |
