# TODO: Error Handling & UX Improvements

**Status: NOT STARTED** — Many API calls use empty `catch {}` blocks, silently swallowing errors. Loading states are inconsistent.

## Summary

Improve error handling, loading states, and user feedback across the app. This is a cross-cutting quality improvement rather than a single feature.

## Tasks

### 1. Replace empty catch blocks
- Audit all `catch {}` blocks in client code
- Replace with toast notifications using `sonner` (already a dependency)
- Show meaningful error messages from API responses
- **Files**: All page files in `src/client/pages/`

### 2. Add loading skeletons
- Show skeleton/shimmer states while data is loading
- Currently most pages show nothing while fetching
- Priority pages: `HomePage`, `SchedulesPage`, `AutomationHistoryPage`
- **Files**: `src/client/pages/HomePage.tsx`, `src/client/pages/SchedulesPage.tsx`

### 3. Retry logic for transient failures
- Add retry wrapper for API calls (1-2 retries with backoff)
- Especially for session/daemon operations that may temporarily fail
- **File**: new `src/client/lib/api.ts` utility

### 4. Connection status indicator
- Show a banner when WebSocket connection is lost
- Auto-reconnect with visual indicator
- **Files**: `src/client/hooks/useCliSocket.ts`, `src/client/pages/DashboardLayout.tsx`

### 5. Confirmation dialogs
- Add confirmation for destructive actions (delete project, delete schedule, delete run)
- Currently some deletes happen immediately on click
- **Files**: Various page files

## File Changes

| File | Change |
|------|--------|
| `src/client/pages/*.tsx` | Replace `catch {}`, add loading states |
| `src/client/lib/api.ts` | New API utility with retry + error handling |
| `src/client/hooks/useCliSocket.ts` | Connection status tracking |
| `src/client/pages/DashboardLayout.tsx` | Connection lost banner |
