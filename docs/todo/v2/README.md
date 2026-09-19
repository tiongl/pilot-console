# v2 — SaaS re-platforming + role-model evolution

**Status: NOT STARTED (strategy / milestone grouping)**

v2 is the architectural leap from a **single-tenant desktop app** (one process,
one user, local SQLite, local worktrees, in-process tools) to a **hosted,
multi-tenant, event-driven platform** with a richer agent org. Everything in this
folder is v2; nothing here is a small incremental feature — each item changes the
architecture, and they share prerequisites.

The through-line: **externalize state, host the control plane, push repo work to
cloud compute, and express roles as data** so the org can grow beyond
CoS→Lead→worker.

## Two tracks, one enabler

```
                         ┌──────────────────────────────┐
                         │  R0  role-registry.md         │  ← shared enabler
                         │  (roles as data: base × lens  │
                         │   × altitude + reportsTo)     │
                         └───────────────┬──────────────┘
             ┌───────────────────────────┴───────────────────────────┐
     Track A: PLATFORM (SaaS re-platforming)          Track B: ROLE MODEL (org scaling)
     persistent-memory-hosted-db.md                   agent-roles-taxonomy.md  (the map)
     always-on-remote-lead.md                         pm-role.md
     cloud-agents.md                                  architect-role.md
     cloud-lead.md                                    ops-runtime-role.md
     saas-multi-tenant.md                             multi-instance-lead.md
```

## Track A — Platform (SaaS re-platforming)

A re-platforming, not a lift-and-shift. Externalize **identity/tenancy, state, and
compute**; keep an always-on control plane because cloud sessions are ephemeral.

| File | What it changes | Depends on |
|------|-----------------|------------|
| `persistent-memory-hosted-db.md` | move state off local SQLite behind `getDb()` to a hosted DB (three-layer memory model) | — |
| `always-on-remote-lead.md` | always-on host + durable daemon + event ingestion + Mission-Control export (R1/R2) | hosted DB |
| `cloud-agents.md` | route workers + the read-only assessor to Copilot cloud sandboxes | always-on |
| `cloud-lead.md` | (optional) re-host Lead tools behind MCP so a cloud Lead can call them (R3) | R0, always-on, hosted DB |
| `saas-multi-tenant.md` | tenancy + auth + per-tenant isolation + billing; ties the platform together | all of the above |

## Track B — Role model (org scaling)

New axes the current CoS/Lead/Worker/Reviewer org does not own, expressed cleanly
once roles are data.

| File | What it adds | Depends on |
|------|--------------|------------|
| `agent-roles-taxonomy.md` | the axes-vs-hats map (framing, not a feature) | — |
| `pm-role.md` | cross-project **intent/priority** (CoS PM-hat → standalone PM) | R0 |
| `architect-role.md` | cross-project **technical coherence** (contract threads → multi-repo review → role) | R0 |
| `ops-runtime-role.md` | the **post-merge runtime** axis (deploy/monitor/incident) | R0, always-on + events |
| `multi-instance-lead.md` | reject multi-project Lead; replicate + share state | hosted DB, R0 |

## Recommended sequencing

1. **R0 — `role-registry.md`** (pure refactor; unblocks both tracks).
2. **Hosted DB — `persistent-memory-hosted-db.md`** (prerequisite for anything multi-host/tenant).
3. **Always-on host — `always-on-remote-lead.md`** (R1 + Mission-Control export spike, then R2 durability/events).
4. **Cloud compute — `cloud-agents.md`** (workers + cloud-portable assessor).
5. **Tenancy — `saas-multi-tenant.md`** (the one genuinely new pillar: `tenant_id` + GitHub-App auth).
6. **Role additions — `pm-role.md`, `architect-role.md`** as cross-project scale demands; **`ops-runtime-role.md`** only if scope grows past "get code merged".
7. **`cloud-lead.md`** (R3) — optional, last; the Lead core stays on the control plane regardless.

**Near-term hybrid milestone** (the realistic first cut of v2): control plane +
hosted DB + on-demand Lead/CoS on one small always-on host, workers pushed to
Copilot cloud sandboxes. Full multi-tenant SaaS (hard isolation, billing, BYOK)
comes after.

## The economic thesis (why v2 is worth it)

The heaviest, most variable cost — **agent token burn** — is offloaded to each
tenant's own Copilot entitlement via cloud sandboxes. You run only a small, shared
control plane + hosted DB, and sell the **coordination layer** (the CoS→Lead→worker
hierarchy, durable memory, the dashboard) that is pilot-console's differentiator.
See `saas-multi-tenant.md` for the full cost breakdown.
