# TODO: Settings & Preferences Page

**Status: NOT STARTED** — No user-facing settings UI despite several configurable aspects.

## Summary

Add a settings page for user preferences. Terminal themes already exist in code (`terminal-themes.ts`) but have no selection UI. Other preferences are hardcoded or use localStorage without a proper settings page.

## Tasks

### 1. Frontend: Settings page
- New route `/settings` with `SettingsPage`
- Sections:
  - **Terminal**: theme picker (from existing `terminal-themes.ts`), font size, font family
  - **Automations**: default renderer type, default cron expression, max runtime default
  - **Notifications**: enable/disable browser notifications, notification types to show
- **File**: new `src/client/pages/SettingsPage.tsx`

### 2. Backend: User preferences storage
- New `user_preferences` table: `user_id, key, value`
- `GET /api/preferences` — get all preferences for current user
- `PUT /api/preferences` — update preferences
- **Files**: `src/shared/db.ts`, `src/server/index.ts`

### 3. Frontend: Apply preferences
- Load preferences on app init via `AuthProvider` or dedicated context
- Apply terminal theme globally
- Use defaults for automation form
- **Files**: `src/client/lib/auth-context.tsx`, `src/client/pages/SchedulesPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | New `user_preferences` table |
| `src/server/index.ts` | Preferences CRUD endpoints |
| `src/client/pages/SettingsPage.tsx` | New settings page |
| `src/client/App.tsx` | Add `/settings` route |
| `src/client/pages/DashboardLayout.tsx` | Settings link in nav |
