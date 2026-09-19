# SaaS — multi-tenant pilot-console

**Status: NOT STARTED (strategy)** — the shape of a hosted, multi-tenant product.
A re-platforming, not a lift-and-shift. Depends on `persistent-memory-hosted-db.md`
(hosted state), `always-on-remote-lead.md` (control plane), and `cloud-agents.md`
(offloaded compute).

## The core shift

Today pilot-console is **single-tenant desktop**: one process, one user, local
SQLite, local worktrees, in-process tools, a daemon owning the SDK runtime. A SaaS
is the *same logical architecture* with three things externalized: **identity/
tenancy, state, and compute.**

```
Browser (per user)
      │ authenticated
Always-on control plane (multi-tenant)
   ├─ API + auth/tenancy
   ├─ monitor + scheduler + router
   └─ hosted DB (per-tenant isolated)
      │  materialize on demand
Ephemeral compute
   ├─ Lead / CoS sessions (on-demand, idle to zero)
   └─ Workers → Copilot cloud sandboxes ──► GitHub
```

## The five things a SaaS must solve

1. **Tenancy & identity** — every user/org is a tenant. Auth = GitHub OAuth / App
   install (already leans on `gh`). Every row, session, worktree, and event gets a
   `tenant_id`; the API enforces isolation on every read/write. **This is the one
   genuinely new pillar** — everything else is relocating existing pieces.
2. **State → hosted, isolated DB** — the three memory layers move off local SQLite
   (`persistent-memory-hosted-db.md`): Layers 2–3 to per-tenant hosted Postgres
   (or DB-per-tenant), Layer 1 as a `copilot_session_id` pointer. `getDb()` is the
   single chokepoint.
3. **Compute → on-demand, not always-running** — this makes the economics work:
   - **Workers** run in **Copilot cloud sandboxes**, billed to the tenant's own
     Copilot entitlement (`cloud-agents.md`).
   - **Lead/CoS** materialize on demand and idle down
     (`getOrCreatePersistentLeadSession`, `agent-bridge.ts:519`).
   - The **control plane** is the only always-on cost, tiny and amortized across
     all tenants.
4. **The always-on control plane cannot be eliminated** — cloud sessions are
   ephemeral and cannot perceive events or hold state, so a persistent
   multi-tenant service must route browser↔session, run the per-tenant monitor +
   scheduler, hold the DB, and materialize agents on demand
   (`always-on-remote-lead.md`).
5. **Isolation & secrets** — each tenant's worktrees, tokens (`gh`/PAT/BYOK), and
   DB walled off. Workers in cloud sandboxes get this free; Lead/CoS compute needs
   per-tenant sandboxing (containers/namespaces). Secrets in a vault keyed by
   tenant, never in the DB.

## Why the economics are attractive

| Cost center | Who pays | Margin impact |
|-------------|----------|---------------|
| Worker compute (the expensive part) | **tenant's own Copilot cloud entitlement** | you don't pay |
| Lead/CoS compute | on-demand, idles to zero | minimal, spiky |
| Control plane + hosted DB | you (shared across tenants) | fixed, amortized |
| Storage (transcripts / memory) | you | cheap, slow growth |

The killer property: the **heaviest, most variable cost (agent token burn) is
offloaded to the user's GitHub plan** via cloud sandboxes. You mostly sell the
**coordination layer** (CoS→Lead→worker hierarchy, memory, dashboard) — exactly
pilot-console's differentiator — on top of compute you do not buy.

## Roadmap (dependency-ordered)

1. **Hosted DB behind `getDb()`** — must be first; nothing is multi-tenant without
   it (`persistent-memory-hosted-db.md`).
2. **Tenancy layer** — `tenant_id` everywhere + GitHub-App auth. The new work.
3. **Workers → Copilot cloud sandboxes** — offloads compute, isolation for free
   (`cloud-agents.md`).
4. **Control-plane hardening** — the always-on monitor/scheduler/router made
   multi-tenant + durable (`always-on-remote-lead.md`, R2).
5. **Lead/CoS on-demand, tenant-scoped, sandboxed** — the lifecycle already exists;
   make it tenant-aware.

**Near-term hybrid** = control plane + hosted DB + on-demand Lead/CoS on your
infra, workers pushed to Copilot cloud. **Full SaaS** later adds hard multi-tenant
isolation, billing, and BYOK. The single new pillar with no analog today is
**tenancy/auth**; everything else is *relocating* existing pieces.
