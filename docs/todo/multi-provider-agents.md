# TODO: Support agentic coding systems other than Copilot

**Status: NOT STARTED** — The Agent path is bound to `@github/copilot-sdk`. The PTY path is already provider-agnostic and only needs a UI.

## Summary

Put a seam between pilot-console and the agent runtime so a project can run on
Claude Code, Codex, Gemini CLI or anything else, instead of only `gh copilot`.

The coupling is far smaller than the codebase's size suggests. Four non-test
files import the SDK, and the API surface actually used is 15 calls:
`createSession`, `resumeSession`, `listSessions`, `listModels`, `start`, `stop`,
and per-session `on`, `send`, `abort`, `getEvents`, `setModel`, `sessionId`,
`workspacePath`, `disconnect`. About 750 of `agent-bridge.ts`'s 2,724 lines
touch any of it.

## Where the coupling lives

| Area | Lines | Notes |
|------|-------|-------|
| `handleSdkEvent` — 25 event types folded into our transcript union | ~370 | Already a normalization layer; the hard thinking is done |
| Connect / create / resume, incl. the hosted-runtime dance | ~150 | Mechanical |
| `onPermissionRequest` / `onExitPlanModeRequest` | ~80 | Copilot-shaped. Claude's `canUseTool` maps; most others have no equivalent |
| `rpc.commands.list` / `rpc.commands.invoke` (slash commands) | ~130 | Copilot-only, and already reached through `as unknown as` — off-contract today |

## Tasks

### 1. Define the seam
- `AgentRuntime` interface covering the 15 calls above.
- A normalized `AgentEvent` union — largely what `handleSdkEvent` already
  produces, lifted into `src/shared/types.ts`.
- Capability flags rather than assumptions: `slashCommands`, `exitPlanMode`,
  `permissionPrompts`, `usageAccounting`, `resumePendingWork`. The UI hides what
  a provider cannot do instead of failing at it.
- **Files**: new `src/shared/agent-runtime.ts`, `src/shared/types.ts`

### 2. Move today's behaviour behind a Copilot adapter
- `src/shared/runtimes/copilot.ts` implements `AgentRuntime` with the existing
  code, unchanged in behaviour. This must be a pure refactor — the current
  tests are the contract.
- **Files**: `src/shared/agent-bridge.ts`, `src/daemon/runtime-host.ts`

### 3. Re-expose the custom tools over MCP
- 36 tools today: 24 in `project-lead-tools.ts`, 9 in `chief-of-staff-tools.ts`,
  2 in `merge-tools.ts`, plus `ask_user`.
- This is the highest-leverage item. The tools *are* the product — the whole
  Chief of Staff → Lead → worker hierarchy lives in them — and MCP is the one
  transport every serious agent already speaks. Serve them once and any
  MCP-capable provider inherits the hierarchy rather than reimplementing it.
- Keep `defineTool` as a thin wrapper over the same handlers so the Copilot
  adapter loses nothing.
- **Files**: new `src/shared/mcp/tool-server.ts`, `src/shared/*-tools.ts`

### 4. Second adapter: Claude Code
- Closest analog: streaming events, tool use, a permission hook, resume by
  session id.
- Proves the seam is real. A third provider afterwards should be days.
- **Files**: new `src/shared/runtimes/claude.ts`

### 5. Surface the PTY path that already works
- `cli-bridge.ts` spawns `COPILOT_CLI_COMMAND` / `COPILOT_CLI_ARGS`
  (default `gh copilot`), so a terminal tab can run another CLI *today* — there
  is just no way to ask for one.
- Make it per-project configuration instead of process-wide env, and add the
  entries to `NewTabMenu`.
- Rename the env vars, keeping the old ones working.
- **Files**: `src/shared/cli-bridge.ts`, `src/server/report-runner.ts`,
  `src/client/components/terminal/NewTabMenu.tsx`,
  `src/client/pages/ProjectChatPage.tsx`

## What degrades off Copilot

Worth deciding deliberately rather than discovering:

- **Session history** — `session-store.ts` reads `~/.copilot/session-store.db`
  directly. Needs a per-provider source, or our own transcript becomes the
  only history.
- **Usage accounting** — built on `copilotUsage.totalNanoAiu` and premium
  requests. No neutral equivalent; likely tokens-and-cost per provider.
- **Skills page** — shells out to `gh copilot plugin marketplace …`.
- **`continuePendingWork: true`** on resume, and `.github/copilot/` instruction
  discovery.
- **Model picker** — `listModels` is per-provider, and lead/worker model
  inheritance assumes one namespace.

## Considerations

- The largest risk is not the adapter — it is the prose. `ASK_USER_INSTRUCTIONS`,
  `buildSystemInstructions`, and the lead/worker protocol are tuned to how
  Copilot behaves. Those need re-tuning per model, and unlike the seam, the test
  suite will not tell us when they are wrong.
- Providers with no structured session API (e.g. Aider) only ever reach PTY-tab
  parity. That is a fine outcome as long as the UI says so.
- Keep Copilot the default and the reference implementation. Every other
  provider should be additive, never a migration.

## File Changes

| File | Change |
|------|--------|
| `src/shared/agent-runtime.ts` | New: `AgentRuntime`, `AgentEvent`, capability flags |
| `src/shared/runtimes/copilot.ts` | New: today's SDK code, moved |
| `src/shared/runtimes/claude.ts` | New: second adapter |
| `src/shared/mcp/tool-server.ts` | New: the 36 tools over MCP |
| `src/shared/agent-bridge.ts` | Talk to `AgentRuntime`, not the SDK |
| `src/daemon/runtime-host.ts` | Host whichever runtime a session asked for |
| `src/shared/cli-bridge.ts` | Per-project CLI command instead of global env |
| `src/shared/session-store.ts` | Per-provider history source |
| `src/client/components/terminal/NewTabMenu.tsx` | Offer the other CLIs |
