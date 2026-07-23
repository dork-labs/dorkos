# Ideation: Capability Registry

- **Slug:** capability-registry
- **Date:** 2026-07-23
- **Tracker:** DOR-428 (project: Agents as First-Class Operators, phase 2)

## Intent

Phase 2 of the agents-as-operators program (`specs/agents-as-operators/02-specification.md` §Implementation Phases): replace hand-registration of agent capabilities with one typed registry from which every surface is generated, so drift becomes impossible by construction and the system can describe itself to the agents it hosts.

## Ideation of record

`research/20260722_agents-as-first-class-operators.md` §3 Pillar 1 (the registry design and its external precedent, Home Assistant's per-integration `async_get_tools` hook) plus the shipped phase-1 evidence: two transport-neutral descriptor tables (`marketplace-tool-descriptors.ts`, `operator-tool-descriptors.ts`) already prove the shape; ADR 260723-013233 commits to the registry subsuming them while preserving tool names, CLI verbs, and flags as the stable contract.

## Decisions carried into SPECIFY

1. The registry is the composition of per-domain capability lists (the Home Assistant pattern), not a central hand-edited file.
2. Phase 2 builds the spine and migrates the proof domains (operator + marketplace); it does not big-bang-migrate every route. The 2,478-line OpenAPI registry is subsumed incrementally.
3. Public contracts frozen by phase 1 (tool names, CLI verbs/flags, HTTP paths) must survive generation byte-compatibly.
4. Every entry declares its permission tier (observe/act/destructive) now, even though enforcement arrives in phase 3 — declaring late would mean re-auditing every capability.
