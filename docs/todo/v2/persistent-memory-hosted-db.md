# Persistent memory & session history in a permanent DB

**Status: PARTLY TRUE TODAY** — session history and project memory are *already*
in permanent stores; the remaining work is moving pilot-console's own tables from
local SQLite to a **hosted/shared DB**, and deciding who owns the SDK conversation
store. Prerequisite for `always-on-remote-lead.md`, `saas-multi-tenant.md`, and
per-project multi-instance (`multi-instance-lead.md`).

## Three memory layers (know which is which)

| Layer | What it is | Where it lives today | Cloud-portable? |
|-------|-----------|----------------------|-----------------|
| **1. Conversation state (SDK-native)** | the real session memory the runtime replays on resume | SDK's `~/.copilot/session-store.db` (shared with the CLI), keyed by `copilot_session_id` | ⚠ depends on the SDK/provider |
| **2. Transcript mirror + role/scope** | serialized transcript for UI + fallback replay, plus kind/project/worktree | pilot-console SQLite — `cli_sessions.output_log` (+ `kind`, `project_id`, `worktree_id`, `copilot_session_id`) | ✅ trivially — it is your DB |
| **3. Semantic memory / history** | project-memory summary, digests, decision threads, todos, delegations, merge queue | pilot-console SQLite (`project_memory`, `delegations`, …) | ✅ trivially — it is your DB |

Key facts, verified in code:

- The runtime's own event log is the source of truth; resume calls `sdk.getEvents()`
  and rebuilds, using `output_log` only as a fallback
  (`agent-bridge.ts:2596-2620`; comment at `:39-48` — "the runtime keeps the
  complete event log on disk and a resume rebuilds from it").
- Layers 2 & 3 are **already in a database you own**: `persistAgentState` writes the
  transcript to `cli_sessions.output_log` (`agent-bridge.ts:1605`); project memory
  is upserted into `project_memory` (`project-memory-store.ts:96-104`).
- `getDb()` is the **single chokepoint** for all of pilot-console's own tables.

## What changes for the hosted / cloud-bound case

**Layers 2 & 3 (yours): straightforward.** Swap the local SQLite file for a hosted
DB behind `getDb()` (Postgres / managed SQLite / LiteFS). Everything — project
memory, digests, decisions, todos, delegations, transcripts — then persists
permanently and is **shared across cloud sessions and the control plane**. This is
exactly the "externalize state" requirement the SaaS and always-on stories depend on.

- Revisit `output_log`'s **full-rewrite-on-save** pattern for a network DB — batch
  or append instead of rewriting the whole transcript each save (see the
  `MAX_TRANSCRIPT_BYTES` trimming logic, `agent-bridge.ts:38-51`).

**Layer 1 (conversation memory): the real decision.** Two options:

1. **Provider-owned pointer.** A cloud session's conversation persists server-side
   at GitHub; keep a `copilot_session_id` pointer in your permanent DB (already
   stored, `cli_sessions`) and re-attach. Easy, durable — but the system of record
   is GitHub, subject to their retention/limits.
2. **Self-owned event mirror.** Since the runtime exposes `getEvents()` and you
   already mirror transcripts, treat your permanent DB as the source of truth:
   persist the full event stream and reconstruct/seed context yourself. More work,
   but makes memory **provider-independent** and immune to cloud-session retention
   — the only way memory survives moving off Copilot cloud.

## The nuance worth stating

Cloud sessions are **ephemeral compute but not necessarily ephemeral memory** —
GitHub persists the conversation and lets you resume, so "cloud = amnesia" is
false. But for your own durable, queryable, cross-session, cross-provider memory
(what a CoS/Lead spanning projects really wants), do **not** rely solely on the
provider store: persist Layers 2 & 3 in your hosted DB (easy, mostly done) and
choose provider-owned vs. self-owned for Layer 1.

## Tasks

1. **DB adapter behind `getDb()`** — pluggable backend (local SQLite default →
   hosted Postgres/SQLite). The one chokepoint makes this contained.
2. **Rework `output_log` persistence** for a network DB — append/batch instead of
   full rewrite.
3. **Layer-1 ownership decision** — ship `copilot_session_id` pointer first;
   add an event-mirror option later if provider-independence matters.
4. Tenancy note: for SaaS, every row gains a `tenant_id` (see
   `saas-multi-tenant.md`); DB-per-tenant is an option for hard isolation.

## Verdict

Persisting session memory + history in a permanent DB is not only possible in the
cloud case — it is the right design, and pilot-console is ~two-thirds there.
Semantic memory + history already live in your SQLite (point it at a hosted DB);
conversation memory is either a provider pointer (easy) or a self-owned event
mirror (robust).
