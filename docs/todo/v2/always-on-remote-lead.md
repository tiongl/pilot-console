# Always-on / remote Lead — hosting, durability, event ingestion (R1/R2)

**Status: NOT STARTED** — feasible as a hosting + durability + event-ingestion
effort, **not** a cloud SDK session. "Always-on" really means
"always-*reachable*, starts on-demand" — you do not want a Lead persistently
running and burning tokens.

## The Lead is already lazy / on-demand

Not a running process — it materializes when needed and idles otherwise:

- `getOrCreatePersistentLeadSession` (`agent-bridge.ts:519`): materialize live →
  resume stored → create fresh.
- `sendToSession` (`agent-bridge.ts:2123`) queues a prompt if the session is busy
  and replays when idle (`:2128-2132`); the SDK runs one turn at a time.
- It already wakes headlessly via `notifyProjectLead` → `sendToSession`
  (`delegation-runtime.ts:30-38`). The browser is only a subscriber; the session's
  owning client is the server's runtime connection.

So "always-on" is not "keep a session hot" — it is "keep the *host* and *event
ingestion* alive so the Lead can be woken from anywhere, any time."

## What actually has to change

The trigger loops live in the **server process**, not the durable daemon:

- `startDelegationMonitor` (60s `setInterval`, `delegation-monitor.ts:140-153`) and
  `startScheduler` are started at `httpServer.listen` (`index.ts:1627-1632`).
- The **daemon** owns the SDK runtime and survives server restarts via `forTcp`
  (`runtime-host.ts:76-78`); the server attaches via `forUri`. But the daemon does
  **not** drive Lead turns today.
- In-flight turns are **not durable** (README): the runtime aborts a mid-flight
  turn when its owning client disconnects.

## Phase 1 (R1) — always-on host + Mission-Control export

1. Deploy server + daemon on an always-on host (a small VM is enough — this is
   Meaning A of "cloud": pilot-console *on* a cloud host, which works today).
2. Move `delegation-monitor` + `scheduler` into — or supervise them alongside — the
   durable daemon, so events are ingested even across server restarts.
3. **Enable Mission-Control export** so a local Lead/worker session is steerable
   from GitHub web/mobile: set `enableRemoteSessions` on the **daemon's `forTcp`
   runtime** (it is *ignored* on the server's `forUri` attach path) and thread
   `remoteSession:'on'` into `createSession`.

### R1 spike — verify Mission-Control export end-to-end

Flip `enableRemoteSessions` on the daemon runtime, thread `remoteSession:'on'`
into `createSession`, confirm a local Lead/worker session appears and is steerable
from GitHub web/mobile. This is the cheapest "remote reach" win and a strong
near-term fit.

## Phase 2 (R2) — durability + events + guardrails

1. **Daemon-owned sessions** so in-flight turns survive a server/browser
   disconnect (today they abort).
2. **GitHub webhook/poll ingestion → `notifyProjectLead`** so the Lead reacts to
   real repo/PR/issue events, not just its 60s tick.
3. **Explicit `reportsTo` edge** (also needed by `role-registry.md`) so hierarchy
   is reconstructable after a restart.
4. **Autonomy + cost guardrails** — spend caps, kill switch, merge-approval gates —
   before letting an always-reachable Lead act unattended.

## What this is NOT

Not the Lead running as a `copilot --cloud` session — that is blocked by its local
in-process tools + local DB + on-disk worktrees. See `cloud-lead.md` for why, and
what re-hosting would be required. The always-on story is about *hosting and
durability of the existing local Lead*, which is tractable today.
