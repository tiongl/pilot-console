# TODO: Skills/MCP Server Selection for Automation Schedules

**Status: DEFERRED** — Copilot intelligently selects the right tools based on prompt context. Per-schedule skill filtering adds complexity for marginal benefit. Revisit if: server interference causes run failures, startup latency becomes noticeable, or isolation is needed for security reasons.

## Summary

Allow users to pick which MCP servers (skills) are enabled per automation schedule. Currently all MCP servers are used for every run; this feature adds per-schedule control.

## Feasibility

**Very feasible.** Key findings:

- `gh copilot -- mcp list --json` returns all configured MCP servers as structured JSON (name, type, source)
- `--disable-mcp-server <name>` flag disables specific servers per-run (can be used multiple times)
- `--disable-builtin-mcps` disables all built-in MCP servers
- `--additional-mcp-config <json>` can inject additional servers per-run

## Approach: Denylist

User picks which servers to **enable** in the schedule form. At run time, unselected servers are disabled via `--disable-mcp-server <name>` flags. `null` in DB means "use all servers" (backward compatible).

## Tasks

### 1. API: Discover available MCP servers
- New endpoint `GET /api/admin/mcp-servers`
- Runs `gh copilot -- mcp list --json`, parses output
- Cache result for 60s to avoid spawning CLI on every form open
- Returns `[{ name, type, source }]`
- **File**: `src/server/routes/schedules.ts`

### 2. Database: Store selected servers per schedule
- Add `mcp_servers TEXT` column to `report_schedules` (JSON array of server names, or null = all)
- Migration in `db.ts`
- Update `ReportSchedule` interface, mapper, and CRUD queries
- **Files**: `src/shared/db.ts`, `src/shared/schedule-store.ts`

### 3. Report runner: Apply denylist flags
- Read `schedule.mcpServers` (parsed JSON array or null)
- If non-null, query available servers and compute disabled set: `allServers - selectedServers`
- Append `--disable-mcp-server <name>` for each disabled server to `cliFlags`
- **File**: `src/server/report-runner.ts`

### 4. UI: Multi-select in schedule form
- Fetch available servers from `/api/admin/mcp-servers` when form opens
- Show checkbox list with server name and type badge (stdio/http)
- Default: all selected (null in DB)
- Store selected names as JSON array
- **File**: `src/client/pages/SchedulesPage.tsx`

### 5. UI: Display selected skills on schedule cards
- Show MCP server badges or comma-separated list on each schedule card
- "All skills" if null, otherwise show selected names
- **File**: `src/client/pages/SchedulesPage.tsx`

## File Changes

| File | Change |
|------|--------|
| `src/shared/db.ts` | Migration: add `mcp_servers` column |
| `src/shared/schedule-store.ts` | Update interface, mapper, CRUD |
| `src/server/routes/schedules.ts` | New `GET /mcp-servers` endpoint |
| `src/server/report-runner.ts` | Build denylist flags |
| `src/client/pages/SchedulesPage.tsx` | Checkbox multi-select + display badges |

## Considerations

- **Null = all**: Backward compatible — existing schedules keep using all servers
- **Built-in MCP** (`github-mcp-server`): Include in the list with a note; disable via `--disable-builtin-mcps` if user unchecks it
- **Plugin discovery**: `gh copilot -- plugin list` has no `--json` flag yet; MCP server list is sufficient since plugins provide MCP servers
- **Cache**: 60s TTL avoids CLI spawns on repeated form opens
