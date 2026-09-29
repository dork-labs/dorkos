---
slug: obsidian-retirement
id: 260925-192121
created: 2026-09-25
status: specified
---

# Retire the Obsidian plugin and exclusive embedded execution

**Status:** Approved by operator brief for implementation and queue delivery.
**Tracked work:** DOR-2343 — Retire the Obsidian plugin and its exclusive embedded execution path.

## Overview

Remove the staged Obsidian surface completely enough that supported changes no longer maintain a second in-process execution path. Preserve a precise recovery point and a useful migration path.

## Background / problem

Obsidian bundles client and server code through DirectTransport with CJS rewrites, native SQLite packaging, host styles and SDK binary resolution. Its build maintenance does not demonstrate the complete experience in Obsidian. The operator does not use it and explicitly authorizes retirement.

## Goals

Remove the plugin app, plugin-only DirectTransport and embedded shells, context callbacks and compatibility branches after a caller census. Reconcile package dependencies, lockfile, test registration, build graphs and obsolete gates. Update active docs, installation/support claims, diagrams and exports. Preserve HTTP, desktop, phone, Cloud and Community behavior. Finish independently reviewed and merged, with safe task-owned cleanup.

## Non-goals

Do not build a replacement, remove useful Transport abstractions, erase historical decisions or releases, publish an obsolete binary, weaken supported-surface safety gates or run paid/live deployments. A future thin server client is a possibility only if demand appears.

## Technical dependencies

Use existing pnpm/Turbo/Vitest/Playwright tooling and pinned diagram renderer. No new runtime dependency is required. Public builds must require no private source or credentials.

## Detailed design

Pin discovery base `dbff5a6f6b3005d4e9815d1b3d485446528f2900`. Client owner removes app embedding and exclusive direct calls, retaining safe router fallbacks used by Dev Playground and upload transforms used by chat. Root removes the plugin app and server/db/shared exclusive helpers after checking all callers; Claude binary/path and cancellation behavior remain if any supported consumer needs them. Documentation owner retains the old plugin guide URL as a migration page and updates active references and rendered architecture diagrams. Shared UI adoption owns portable controls; reconcile overlapping guides without dropping their updates.

Remove the plugin-only UI command, sidebar-tab state and unavailable harness status from shared API contracts. Older UI snapshots may still send the removed field; normal Zod parsing ignores it. Keep stored Shape sidebar-tab metadata readable. No stored user-data migration is needed. Do not delete vault files, runtime transcripts, shared DorkOS configuration or database. Any shared contract cleanup must retain supported implementations and test mocks. CI changes receive a hygiene ledger entry and census/ledger verification; required contexts and unrelated safety floors remain.

## User experience

Explain the loss of in-vault sidebar, active-note prompt context, dragged note context and native note opening. A vault is an ordinary local Markdown folder usable by the normal app subject to ordinary permissions. Do not promise active-note awareness or plugin parity. Explain disabling/removing the old plugin safely, and that finding old sessions may require selecting its former working folder (the vault parent). Preserve shared runtime history.

## Testing strategy

Run affected unit tests and typechecks, client/server/CLI/desktop/shared UI builds relevant to touched behavior, package registration and CI guards. Run supported app browser smoke and inspect screenshots for remaining shell behavior. Use mocks at Transport boundaries and no paid evals. Confirm source references to removed identifiers are either gone or explicitly historical. Review spec compliance and code quality with a separate agent in a stable checkout after pushing; fix and repeat before PR creation. Run final CI and merge queue checks.

## Performance

Deletion reduces build and test work; no speed claim is required. CI changes are retirement hygiene, not an unmeasured performance experiment.

## Security

No user data is removed. Keep runtime confinement, permission boundaries, shared native dependencies and supported auth behavior. Recovery is source access, not a claim that the old plugin remains safe or maintained.

## Documentation

Active user/contributor docs, package maps, current strategy, one retirement ADR, changelog removal fragment, diagram sources/exports, exact historical commit/tree and recovery procedure. Preserve ADR/spec/release history. Keep an honest evidence limit on external usage.

## Implementation phases

1. Census and parallel client/docs/root cleanup in separate worktrees.
2. Integrate changes, verify supported surfaces and reconcile shared UI overlap.
3. Push stable branch, independent review until converged, PR plus queue delivery.
4. Confirm merge, close tracker scope and safely remove only clean task-owned worktrees.

## Open questions

None requiring new authorization. External source-built usage remains unknown; migration documentation accounts for it.

## Related ADRs and references

Transport architecture and prior Obsidian decisions remain historical. Retirement ADR is authored with documentation. Durable execution state lives in this spec directory and local `.dork/flow/flow-state.json`.
