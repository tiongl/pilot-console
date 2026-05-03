# TODO: Automation Analytics Dashboard

**Status: NOT STARTED** — No visibility into automation health or trends beyond individual run history.

## Summary

Add an analytics overview for automation schedules showing success/failure rates, runtime trends, and health indicators. Helps users identify flaky or slow automations.

## Tasks

### 1. Backend: Aggregate stats endpoint
- `GET /api/admin/schedules/stats` — returns per-schedule stats
- Metrics: total runs, success/failure/timeout counts, avg runtime, last run status
- Optional time range filter (`?since=`)
- **Files**: `src/server/routes/schedules.ts`, `src/shared/schedule-store.ts`

### 2. Backend: Global automation stats
- `GET /api/admin/automation/summary` — overall stats
- Total schedules, active/paused counts, runs today/this week, failure rate
- **File**: `src/server/routes/schedules.ts`

### 3. Frontend: Analytics tab on AutomationHistoryPage
- Add a "Stats" or "Analytics" tab/section
- Per-schedule cards showing: success rate bar, avg runtime, last failure
- Color-coded health indicators (green/yellow/red)
- Sortable by failure rate, runtime, last run
- **File**: `src/client/pages/AutomationHistoryPage.tsx`

### 4. Frontend: Sparkline charts (optional)
- Small inline charts showing run history over time
- Use a lightweight chart library (e.g., `recharts` or SVG-based)
- **File**: `src/client/pages/AutomationHistoryPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/shared/schedule-store.ts` | Aggregate query functions |
| `src/server/routes/schedules.ts` | Stats endpoints |
| `src/client/pages/AutomationHistoryPage.tsx` | Analytics UI |
