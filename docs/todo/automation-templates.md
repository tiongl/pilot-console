# TODO: Automation Templates

**Status: IMPLEMENTED**

## Summary

Provide a library of built-in automation templates (e.g., "Daily PR summary", "Dependency audit") and allow users to save their own automations as reusable templates.

## Approach

- Ship a set of built-in templates as a JSON file bundled with the app
- Store user-created templates in the database
- Add a template picker to the schedule creation dialog

## Tasks

### 1. Define built-in templates
- Create `src/server/automation-templates.ts` with template definitions
- Each template: `{ id, name, description, category, prompt, cronExpression, rendererType }`
- Categories: "Code Review", "Security", "Reporting", "Maintenance"
- Example templates:
  - Daily PR summary
  - Weekly dependency update check
  - Code review digest
  - Open issues summary
  - Repository health check
- **File**: `src/server/automation-templates.ts`

### 2. API endpoints
- `GET /api/admin/templates` — returns built-in + user templates
- `POST /api/admin/templates` — save a user template
- `DELETE /api/admin/templates/:id` — delete a user template
- **File**: `src/server/routes/schedules.ts`

### 3. Database: User templates table
- Add `automation_templates` table: `id, name, description, category, prompt, cronExpression, rendererType, isBuiltIn, createdBy, createdAt`
- **File**: `src/shared/db.ts`

### 4. UI: Template picker in schedule dialog
- Add a "Start from template" button/section in the new schedule dialog
- Show template cards grouped by category
- Clicking a template pre-fills the form fields
- **File**: `src/client/pages/SchedulesPage.tsx`

### 5. UI: "Save as template" on existing schedules
- Add a "Save as template" option in the schedule card actions
- Opens a dialog to name/describe the template
- **File**: `src/client/pages/SchedulesPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | New `automation_templates` table |
| `src/server/automation-templates.ts` | Built-in template definitions |
| `src/server/routes/schedules.ts` | Template CRUD endpoints |
| `src/client/pages/SchedulesPage.tsx` | Template picker + save-as-template |
