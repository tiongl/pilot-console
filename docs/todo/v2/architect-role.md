# Architect — cross-project technical coherence

**Status: NOT STARTED** — buildable near-term slice (contract threads) + a
capability (multi-repo review) before any standing role. Gated on
`role-registry.md` (R0). See `agent-roles-taxonomy.md`.

## The gap it fills

A third cross-project axis that neither the PM nor the CoS owns. Where the PM
answers *should we build it* (product intent), the Architect answers *will B's
change break A's contract, are they on compatible versions, do they share the
pattern* — **technical coherence** across projects.

It is the architectural sibling of the reviewer: the reviewer checks *correctness*
within one repo; the Architect checks *fit* across repos.

## Concrete concerns, none currently owned

| Cross-project technical concern | Owner today | Failure if unowned |
|---------------------------------|-------------|--------------------|
| Shared API / contract between two projects | nobody | B ships a breaking change; A finds out at integration |
| Dependency / version alignment | nobody | diamond conflicts, incompatible shared libs |
| Architectural pattern consistency | nobody | each project drifts to its own conventions |
| Shared library change propagation | nobody | a lib change lands; N consumers silently rot |
| Integration seams (events, schemas, auth) | nobody | contract mismatch found late |

## The twist: this axis needs multi-repo *grounding*

Unlike the PM (small, abstract backlog state), the Architect's judgment must
actually **read across two+ projects' code/contracts**. It needs the assessor's
superpower (read a diff, read a contract, run a compatibility check) pointed at
**≥2 repos at once**. So it is cross-project *and* technical — the hardest to place.

## Recommended path (buildable → capability → role)

1. **Near-term, buildable, no new role: cross-project contract / decision threads.**
   The cleanest oversight is making the fit **explicit and shared** rather than
   watched. Let a decision thread / interface spec **span project_ids** and act as
   a **fit dependency edge** between projects. Then a breaking change becomes a
   *reviewable event against a known contract*, not a surprise. The decision-thread
   machinery already stores cross-cutting verdicts; the missing piece is the
   multi-project scope + the dependency edge. **This delivers most of the value
   with zero new role.**

2. **Capability: cross-project technical-fit review** — the multi-repo sibling of
   `spin_off_review` (`project-lead-tools.ts:582`). A read-only assessor with read
   access to the integration surface of two+ projects checks contract
   compatibility, version alignment, pattern consistency, and reports a fit verdict
   up. Never modifies anything. **CoS-triggered** — the CoS already has the
   cross-project awareness to notice "these two projects touch the same contract"
   and fire the review at integration boundaries. Runs on-demand, idles otherwise.

3. **Standing Architect role** — only at real scale: many interdependent projects,
   a shared platform/library layer, frequent breaking-change risk. Same discipline
   as the PM: build the seam now (R0), add the seat when the pain is real.

```
CoS ──(notices shared-contract change)──► spin off tech-fit review
                                             read A's contract  ┐
                                             read B's contract  ┘ (read-only)
                                          ► fit verdict: compatible / breaking
CoS ──(route findings)──► Lead A , Lead B
```

## Pressure-test: is it distinct from the reviewer?

Yes. The reviewer is single-repo + correctness. The Architect is multi-repo + fit.
Same read-only *mechanism*, different *scope and question* — exactly the
axis-vs-hat distinction. It is an assessor with a cross-project altitude and an
`architecture` lens (in R0 terms), which is why the near-term slice (contract
threads) can ship before any dedicated role exists.
