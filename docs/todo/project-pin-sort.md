# TODO: Project Pin & Sort UI

**Status: NOT STARTED** — Database fields `pinned` and `sort_order` already exist on the `projects` table but there is no UI to use them.

## Summary

Expose project pinning and custom ordering in the dashboard. The DB schema already supports `pinned` (boolean) and `sort_order` (integer) columns via migrations — this is purely a frontend task with minor API additions.

## Tasks

### 1. Pin/unpin button on project cards
- Add a pin/star icon button to each project card on `HomePage`
- Call `PATCH /api/projects/:id` with `{ pinned: true/false }`
- Pinned projects appear at the top of the list
- **File**: `src/client/pages/HomePage.tsx`

### 2. Drag-and-drop reorder
- Add drag-and-drop to project cards using a lightweight library (e.g., `@dnd-kit/core`)
- On drop, update `sort_order` for affected projects
- Add `PATCH /api/projects/reorder` endpoint accepting `[{ id, sort_order }]`
- **Files**: `src/client/pages/HomePage.tsx`, `src/server/index.ts`

### 3. Sort logic
- Backend: order by `pinned DESC, sort_order ASC, created_at DESC`
- Update `listProjects()` query
- **File**: `src/shared/project-store.ts`

## File Changes

| File | Change |
|------|--------|
| `src/client/pages/HomePage.tsx` | Pin button, drag-and-drop |
| `src/server/index.ts` | Reorder endpoint |
| `src/shared/project-store.ts` | Update sort query |
