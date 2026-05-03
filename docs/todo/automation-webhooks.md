# TODO: Automation Webhooks & External Triggers

**Status: NOT STARTED** — Automations can only run via cron schedule or manual "Run now" button.

## Summary

Allow automations to be triggered externally via webhook URLs and optionally by GitHub events (push, PR, issue). Enables event-driven automation in addition to time-based.

## Tasks

### 1. Backend: Webhook trigger endpoint
- `POST /api/webhooks/:scheduleId/trigger` — trigger a specific automation
- Auth via webhook secret token (generated per schedule)
- Return run ID for status polling
- **File**: `src/server/routes/schedules.ts`

### 2. Database: Webhook secrets
- Add `webhook_secret` column to `report_schedules` (nullable)
- Generate on demand when user enables webhook for a schedule
- **Files**: `src/shared/db.ts`, `src/shared/schedule-store.ts`

### 3. Frontend: Webhook configuration
- Toggle to enable/disable webhook per schedule
- Show webhook URL and secret (copyable)
- Regenerate secret button
- **File**: `src/client/pages/SchedulesPage.tsx`

### 4. GitHub event triggers (optional)
- Accept GitHub webhook payloads at `POST /api/webhooks/github`
- Map event types to schedules via a trigger rules table
- Filter by repo, event type, branch
- **Files**: `src/server/routes/schedules.ts`, `src/shared/db.ts`

### 5. Automation chaining (optional)
- On run completion, optionally trigger another schedule
- Add `chainTo` field on schedules (nullable schedule ID)
- **Files**: `src/server/report-runner.ts`, `src/shared/schedule-store.ts`

## Considerations

- Webhook endpoint should NOT require session auth (uses secret token instead)
- Rate limiting to prevent abuse
- Log webhook trigger source in run metadata

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | `webhook_secret` column, trigger rules table |
| `src/shared/schedule-store.ts` | Webhook secret CRUD |
| `src/server/routes/schedules.ts` | Webhook trigger endpoint |
| `src/client/pages/SchedulesPage.tsx` | Webhook config UI |
| `src/server/report-runner.ts` | Chain trigger on completion |
