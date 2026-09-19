# Ops / Runtime — the post-merge lifecycle axis

**Status: NOT STARTED (design)** — the one genuinely unowned *axis* (not a hat).
The biggest cleanly-missing piece if the system's scope grows beyond "get code
merged." Gated on `role-registry.md` (R0). See `agent-roles-taxonomy.md`.

## The gap it fills

Every current role's responsibility **ends at the merge**. Worker builds, Reviewer
assesses, Lead coordinates, CoS is aware, PM prioritizes, Architect checks fit —
all *before or at* merge. Nothing owns what happens **after**: deploy, monitor,
incident response, rollback, "is it healthy in production and what do we do when
it breaks."

This is not a hat on any existing base primitive. "Operate a running system and
respond to incidents" is neither building, assessing, nor coordinating pre-merge
work — it is a **new verb**, which is why it is a distinct axis and not a lens.

## Why it is distinct from everything else

| Existing base | Verb | Ops? |
|---------------|------|------|
| worker | build | ✗ — Ops doesn't produce a deliverable diff |
| assessor | judge (read-only, pre-merge) | ✗ — Ops acts on live systems, post-merge |
| coordinator | orchestrate pre-merge work | ✗ — Ops orchestrates *runtime*, reacts to production signals |

## What an Ops role would own

- **Deploy / release** — promote a merged change to an environment (extends the
  Lead's `approve_merge` past the merge into ship).
- **Monitor** — ingest health/metrics/alerts from running systems.
- **Incident response** — detect, triage, and drive mitigation/rollback.
- **Runbooks** — codified responses to known failure modes.

## Trigger model (this is the crux)

Ops is fundamentally **event-driven on production signals**, not on repo events.
That maps onto the same always-on control plane the Lead needs
(`always-on-remote-lead.md`): a persistent monitor that ingests alerts/webhooks
and materializes an Ops agent on demand, just as `notifyProjectLead` wakes the
Lead. Ops cannot be a cloud/ephemeral session for the same reason the Lead cannot
(see `cloud-lead.md`) — it must perceive events and hold state.

## Recommended path

1. **Prerequisite:** the always-on control plane + event ingestion (R1/R2). Ops is
   pointless without a durable process that can perceive production signals.
2. **Capability first:** a "release" tool that extends `approve_merge` into deploy,
   plus alert/webhook ingestion → `notifyOps` (mirror of `notifyProjectLead`).
3. **Standing role:** an `ops` `RoleDef` under R0 — a coordinator at runtime
   altitude with deploy/monitor/rollback tools and a runbook store — only once the
   system actually operates something worth an on-call agent.

## Explicit scope note

Only pursue this if pilot-console's ambition grows past "coordinate code changes
to merge" into "own the running system." Until then it is the correctly-identified
*next* axis, deliberately deferred — recorded here so it is not rediscovered as a
surprise.
