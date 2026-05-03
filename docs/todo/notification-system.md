# TODO: Notification System

**Status: NOT STARTED** — Only the automation badge (unseen report count) exists. No general notification framework.

## Summary

Build an in-app notification center for automation failures, long-running sessions, and other events. Currently the only feedback is the automation badge count and toast notifications for completed reports.

## Tasks

### 1. Backend: Notifications store
- New `notifications` table: `id, type, title, message, link, read, createdAt`
- Types: `automation_failure`, `automation_complete`, `session_error`, `system`
- CRUD: create, list (with unread count), mark read, mark all read, delete
- **Files**: `src/shared/db.ts`, new `src/shared/notification-store.ts`

### 2. Backend: Generate notifications
- On automation run failure → create notification with link to run detail
- On automation run timeout → create notification
- Emit via existing WebSocket connection
- **Files**: `src/server/report-runner.ts`, `src/server/websocket.ts`

### 3. Frontend: Notification bell + dropdown
- Bell icon in `DashboardLayout` header with unread badge
- Dropdown showing recent notifications
- Click to navigate to relevant page
- "Mark all read" button
- **File**: `src/client/pages/DashboardLayout.tsx`

### 4. Frontend: Browser notifications (optional)
- Request permission for browser `Notification` API
- Push desktop notifications for failures even when tab is not focused
- **File**: `src/client/hooks/useReportNotifications.ts`

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | New `notifications` table |
| `src/shared/notification-store.ts` | New notification CRUD |
| `src/server/report-runner.ts` | Create notifications on failure/timeout |
| `src/server/websocket.ts` | Emit notification events |
| `src/client/pages/DashboardLayout.tsx` | Bell icon + dropdown |
