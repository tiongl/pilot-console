# TODO: Report Sharing & Delivery

**Status: NOT STARTED** — Reports are only viewable in the web UI by authenticated users.

## Summary

Allow sharing automation report outputs externally — via shareable links, PDF export, or delivery to Slack/Teams/email.

## Tasks

### 1. Shareable links
- Generate a time-limited public URL for a specific report run
- `POST /api/admin/runs/:id/share` → returns `{ url, expiresAt }`
- Public route `GET /api/shared/:token` returns rendered report (no auth)
- New `shared_reports` table: `token, runId, expiresAt, createdBy`
- **Files**: `src/server/routes/schedules.ts`, `src/shared/db.ts`

### 2. PDF export
- Add a "Download PDF" button on `ReportViewerPage`
- Use browser `window.print()` with print-optimized CSS, or a library like `html2pdf.js`
- **File**: `src/client/pages/ReportViewerPage.tsx`

### 3. Email delivery (optional)
- On automation completion, optionally email the report
- Per-schedule config: email recipients list
- Use `nodemailer` or similar
- **Files**: `src/server/report-runner.ts`, `src/client/pages/SchedulesPage.tsx`

### 4. Slack/Teams webhook delivery (optional)
- Per-schedule config: webhook URL for Slack/Teams
- Post report summary to channel on completion
- **Files**: `src/server/report-runner.ts`, `src/client/pages/SchedulesPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | `shared_reports` table |
| `src/server/routes/schedules.ts` | Share/public endpoints |
| `src/client/pages/ReportViewerPage.tsx` | PDF export + share button |
| `src/server/report-runner.ts` | Email/Slack delivery on completion |
| `src/client/pages/SchedulesPage.tsx` | Delivery config in schedule form |
