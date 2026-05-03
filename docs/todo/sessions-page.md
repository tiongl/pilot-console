# TODO: Sessions Page

**Status: NOT STARTED** — `SessionsPage.tsx` is currently a placeholder with no actual content. This is a core navigation item that users see but can't use.

## Summary

Build a proper session history browser that shows all past Copilot CLI sessions across projects. Currently the only way to see session history is per-project via the side panel.

## Approach

- Query sessions from `~/.copilot/session-store.db` (already done by `session-store.ts`)
- Show a filterable, sortable table of all sessions
- Link each session to its transcript viewer
- Show project association, duration, and timestamp

## Tasks

### 1. Backend: Enhance session listing
- The existing `GET /api/sessions/active` only returns active sessions
- Add `GET /api/sessions` endpoint for all sessions with pagination
- Support query params: `?project=`, `?search=`, `?limit=`, `?offset=`
- **File**: `src/server/index.ts`

### 2. Frontend: Build SessionsPage
- Replace placeholder with a table/card list of sessions
- Columns: project name, session summary, started at, duration
- Filters: project dropdown, date range, search text
- Click to view transcript
- **File**: `src/client/pages/SessionsPage.tsx`

### 3. Session transcript viewer
- Ensure `/api/sessions/:id/transcript` works for all sessions (not just project-scoped)
- Add a dedicated transcript viewer page or modal
- **File**: `src/client/pages/SessionsPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/server/index.ts` | Add `GET /api/sessions` with pagination/filters |
| `src/client/pages/SessionsPage.tsx` | Full rewrite from placeholder to session browser |
| `src/shared/session-store.ts` | May need additional query methods |
