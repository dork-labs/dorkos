---
slug: capability-mcp-full-schemas
number: 261116-033650
created: 2026-11-16
status: ideation
---

# Register capability MCP tools with full input schemas

**Slug:** capability-mcp-full-schemas  
**Author:** Codex, delegated IDEATE agent  
**Date:** 2026-11-16  
**Issue:** [DOR-2067](https://linear.app/dorkspace/issue/DOR-2067)  
**Source base:** `1cc1a721518d4287412ea1a6ef33e9283b576594`

## 1) Intent & Assumptions

- **Task brief:** Register ordinary registry capabilities on Claude's MCP server with a full `ZodObject`, reject unknown arguments, preserve each session's `alwaysLoad` exposure and search hints, retain omitted defaults, and retire `portableInputShape` and its capability workaround guard. The issue explicitly requests an internal change: no changelog fragment and `skip-changelog` on the eventual PR.
- **Current evidence supersedes the historical cause:** SDK `0.3.304` already understands Zod's `defaulted` rung. A raw defaulted field works on this pin. The remaining architectural problem is real: raw-shape reconstruction drops object-level strictness and refinements. The old default workaround is now unnecessary coupling.
- **Assumptions:** The registry remains the authority for validation, permissions, approval binding, execution and result semantics. SDK imports stay within Claude's runtime directory. The same registry declarations continue serving HTTP, external MCP, native runtime MCP and extension tools.
- **Out of scope:** Native hand-tool availability (DOR-4481), changing the eager-loading set, permission or approval policy changes, SDK/package upgrades, support for new extension-schema keywords, real model/provider calls, and task own-folder guards shipped on main. DOR-4485 is an existing delivery blocker, not permission to bypass verification.

## 2) Pre-reading Log

- `AGENTS.md`, the Flow README, `ideating-features/SKILL.md`, the real ideation scaffold and `linear-adapter/SKILL.md`: all planning remains in this isolated worktree; tracker writes use Flow's configured account. The configured adapter and unpaused state were verified by `config-files.ts`.
- The live issue and typed relations: DOR-2067 is claimed in IDEATE and blocked by DOR-4485; its four validation criteria and no-changelog instruction remain binding.
- `specs/README.md`, `specs/manifest.json`, `.claude/scripts/id.ts` and `spec-manifest-ops.ts`: new timestamp identity and canonical `ideation` status; no new sequential counter.
- `meta/VISION.md`, `meta/PRINCIPLES.md`, `meta/VOICE.md`, `meta/ROADMAP.md`: preserve vendor-independent behavior and describe only proven functionality. This internal migration adds no public capability claim.
- `research/runtime-upgrades/claude-agent-sdk/0.3.280-to-0.3.304/impact-assessment.md`: bundled Zod changed after the original workaround. Its measured record-listing improvement is separate from a live model accepting every schema form; existing extension restrictions stay.
- `decisions/260923-223905-permission-decisions-ride-the-tier-gate.md`: keep the three gate choke points and existing approval machinery; registration must not introduce another permission path.
- `packages/shared/src/portable-input-shape.ts`, `core/capabilities/{input-projection,mcp-projection,registry}.ts`, both capability MCP modules, Claude's factory/exposure/digest modules, default/attribution/exposure/input-projection tests and `packages/extension-api/src/tool-check.ts`: actual callers and parse ownership below.
- Installed primary sources: `@anthropic-ai/claude-agent-sdk@0.3.304/sdk.mjs` and `sdk.d.ts`, MCP SDK `1.32.0` registration/validation code, Zod `4.6.7` object extension implementation. No web or model inference was needed.

## 3) Codebase Map

| Module                                                                            | Role and constraint                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/core/capabilities/input-projection.ts`                  | Peels outer preprocess pipes to recover the advertised object. Original executable input remains on the capability.                                                                                                                                                                        |
| `apps/server/src/services/core/capabilities/mcp-projection.ts`                    | Currently extracts `.shape`, adds `approvalToken` only for `canRaiseApproval`, then normalizes substituting defaults. Shared invocation preserves result envelopes, cards and holds.                                                                                                       |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/capability-mcp-tools.ts` | Ordinary capabilities currently become SDK `tool()` raw definitions. The current 12 principal-bound capabilities already register full objects directly; comments and older tests still say five or seven. Both paths must retain per-call context/signal and distinct audience semantics. |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/index.ts`                | Combines hand and registry tools, applies hidden-name filtering, constructs the SDK server, adds principal-bound tools, records the complete surface digest, and adds resources. Maintain one actual registration and digest entry per visible tool.                                       |
| `apps/server/src/services/runtimes/shared/tools/tool-exposure-policy.ts`          | Selects standing versus registered-agent eager sets and derives search hints. Preserve these decisions unchanged.                                                                                                                                                                          |
| `apps/server/src/services/runtimes/claude-code/mcp-tools/tool-surface.ts`         | Already accepts full schemas. Stable name/description/input-schema digest drives warm-process replacement. A changed schema may legitimately change the digest once; unchanged builds must match.                                                                                          |
| `apps/server/src/services/core/external-mcp/capability-mcp-tools.ts`              | Also imports `capabilityInputShape`; migrate this caller to a full object before deleting the helper. Keep external token/poll behavior, contextual audience, hidden names and cancellation.                                                                                               |
| `packages/extension-api/src/tool-check.ts`                                        | Live consumer of the shared portable helper. Replace its obsolete raw-map listing check with the full-object listing contract, while preserving the closed-schema subset, reserved keys, bounded checks and rejection reasons.                                                             |
| `packages/shared/{src/portable-input-shape.ts,package.json}`                      | Retire the helper source and its subpath export only after every live consumer is migrated. Do not leave a renamed shim.                                                                                                                                                                   |

**Current data flow:** capability declaration → advertised object → raw field map plus optional approval argument → portable normalization → SDK rebuild/parse → invocation wrapper → registry's original parse → permission gate/hash → handler → MCP envelope. The external server takes a similar route through the installed MCP SDK. Full registration should eliminate the raw reconstruction stage, with parse equivalence proven rather than assumed.

**Blast radius:** ordinary in-session and external capability listings/calls, approval-token advertisement, principal-bound tools, extension contribution/marketplace validation, generated capability docs, warm launch fingerprints, and source-level references to removed exports. HTTP input policy itself must not change.

## 4) Root Cause Analysis

### Current-pin reproduction

An offline probe creates the real SDK server and connects the real MCP client through `InMemoryTransport`. Four tools are actually listed and nine calls run. It neither starts `query()` nor launches a model.

| Input/path                                                | Observed on SDK 0.3.304, MCP 1.32.0, Zod 4.6.7                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Raw `{ limit: z.number().default(7) }`, call `{}`         | Handler receives `{ limit: 7 }`; historical default-rung failure is absent.                                 |
| Full strict object, call `{}` or `{ limit: 3 }`           | Defaults and explicit values survive.                                                                       |
| Raw shape, call `{ limit: 3, ownerId: 'hostile' }`        | Unknown key is stripped and the handler runs.                                                               |
| Full strict object, unknown `ownerId` or ordinary `extra` | MCP validation refuses before the handler; zero handler calls.                                              |
| Refined full object extended with optional approval token | Valid positive reaches the handler; failed refinement does not.                                             |
| Full prefault and optional-default fields                 | Their omitted values reach this SDK handler intact. This alone does not prove registry reparse equivalence. |

The SDK's `tool()` factory derives `_meta['anthropic/alwaysLoad']` and `_meta['anthropic/searchHint']`. Copying its generated metadata into full-object registration gives identical actual `tools/list` metadata. Avoid inferring exposure from a local descriptor alone.

Evidence is retained privately in this worktree under `.dork/flow/tmp/2067-ideate/sdk-probe.{mjs,json,log}` and `sdk-primary-source.json`; the latter pins the bundle hash and relevant minified source offsets. The first probe attempt failed on a non-exported `package.json` path before running calls; it was corrected to read versions beside resolved entries. Only the successful run is evidence.

### Parse ownership is a required design check

`registry.ts` parses the original executable schema once before gating and hashing. SDK validation happens before that. Simply substituting the original projected object can change what reaches the registry:

- A synthetic version of the existing bounded-preprocess fixture accepts a 39-byte raw object on the old portable path. Full-object validation first inserts `limit: 5`; the original 40-byte preprocessor then refuses the larger object.
- A synthetic `.prefault('seed')` over a non-idempotent `value + '!'` transform returns `seed!` on the old path and `seed!!` on the naive full-object path.

These are real SDK and original-schema parse observations, **not claims that a production capability currently has these exact inputs**. No production `.prefault()` was found in the searched source; actual bounded canvas request roots inspected here have no substituting defaults. Evidence: `parse-ownership-probe.{mjs,json,log}`. This narrow probe uses the original parse in a callback, matching the registry's parse order; actual registry/gate equivalence remains an implementation acceptance requirement.

SPECIFY must make parse ownership explicit and examine the composed current schema set, including nested coercions, preprocessors, transforms and refinements. It must not promise arbitrary schema equivalence based on ordinary default tests, invent a privileged parsed-input bypass, or rename the portable workaround. Any incompatible real declaration must receive a concrete, reviewed resolution before execution is frozen.

### Listability remains a separate contract

Three isolated direct-registration probes each include a known-good tool. Plain and record candidates both list on this pin; `z.date()` fails the entire direct server's `tools/list`, including the good sibling. `sdk-listability-probe.{mjs,json,log}` records all three outcomes. Direct registrations bypass `createSdkMcpServer()`'s per-definition unconvertible-schema disabling wrapper. Keep the existing extension schema restrictions; current record conversion does not authorize broadening them or claim a real model accepted those forms.

### Current composed-schema census

The actual docs composition with every optional domain supplied and the To-dos flag on contains **131 capabilities, 117 ordinary MCP capabilities in the union (116 in-session / 84 external), 12 principal-bound IDs, and 129 MCP-relevant declarations**. Enumeration follows the real registry and constant, not a new hand-maintained list. The two outer pipes are bounded canvas send/patch; neither contains defaults. Current relevant schemas have 29 default nodes including nested traits/MCP configuration (15 top-level fields across 14 capabilities), no prefaults, and no value-changing transforms beyond those two non-mutating bound preprocessors. Recursive JSON union source was inspected separately.

Three private current-schema parsing probes pass: the actual composition census; all 29 current default nodes through real full-object SDK registration and the real registry in isolated observe fixtures; and both original canvas input schemas at exactly 16,384 bytes with 16,385-byte refusal. These are schema/registry proofs with recording handlers, not production-service or authority claims. Own dependency build passed 17/17 tasks. Logs and exact scope are retained in `census-and-semantics-restored.log`, `schema-census.json`, `current-defaults-proof.json`, and `current-canvas-proof.json`.

## 5) Research

| Option                                                                                     | Assessment                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep raw maps and delete only normalization                                                | Current defaults work, but strictness/refinements are still lost. Does not satisfy the issue.                                                                                                                                                                                                                                                                                                                      |
| Register full objects and hand-write metadata keys everywhere                              | Meets the schema direction but duplicates the SDK's exposure encoding and invites drift.                                                                                                                                                                                                                                                                                                                           |
| **Full-object registration, SDK-generated exposure metadata, unchanged shared invocation** | Recommended direction. Recover a strict full advertised object without mutating the capability, add the approval argument only where allowed, register after SDK server creation, and return exact digest entries. Use a narrow Claude-local bridge to the SDK factory's metadata rather than a second exposure policy. Resolve parse ownership with concrete current declarations before freezing implementation. |
| New registry invocation/approval path or a renamed portable helper                         | Reject. Registration cleanup does not justify weakening authoritative validation or moving approval binding to a second path.                                                                                                                                                                                                                                                                                      |

The original object/refinement must survive extension; use the pinned object API rather than reconstructing `z.object({ ...shape })`. Zod 4.6.7 preserves checks for additive `.extend()` and `.safeExtend()`; ordinary `.extend()` throws only when overwriting a key on a refined object. The probe did not observe the older claim that every refined extension throws.

### Verification direction

1. Use the real SDK-created `server.instance` and a real MCP client for omitted defaults, actual handler values, strict unknown-key refusal, exposure metadata, names and schemas. Include positive calls beside refusals and exact nonzero counts.
2. Exercise actual registry parsing/gating for current preprocess/refinement/default contracts and approval arguments. Preserve input hash semantics, in-session held/card behavior, external token/poll, audience, fresh session identity and cancellation. Include approved execution and denied/no-handler controls.
3. Run actual combined hand/registry/principal-bound listings for plain and registered-agent sessions; hidden names stay absent, connector turn changes do not silently change the warm surface, and repeated unchanged digests match.
4. Replace obsolete capability raw-rung tests with behavior tests. Preserve hand-tool safety independently; decide from the current SDK contract rather than repeating the historical claim that all raw defaults fail. Do not normalize hand schemas that are parsed only once.
5. Retire the extension helper consumer with valid defaulted declarations and refused unsupported declarations. Verify the surviving app list rather than a fake `registerTool` counter. Search the complete tree, including hidden config and prose, for every removed helper/export and update living references; retain historical facts only when labelled historical.
6. Independent `REVIEW.md` Stage 1 then Stage 2, targeted tests/types/lint, normal hooks and the required exact-head full verification precede PR delivery. Useful removal controls are full-object→raw reconstruction, strictness removal and metadata removal; the historical default bug cannot honestly be used as a current-pin red control.

## 6) Decisions

| #   | Decision                   | Choice                                                                                        | Rationale                                                                                                                              |
| --- | -------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is the task still needed?  | Yes, with an updated problem statement.                                                       | Strict object semantics and eliminating obsolete coupling remain valuable; the historical default failure is already fixed by the pin. |
| 2   | Registration boundary      | Full object on both capability MCP paths; retain the original registry authority.             | Satisfies strict input without forking permissions or caller identity.                                                                 |
| 3   | Exposure                   | Keep current sets and SDK-generated metadata.                                                 | A schema cleanup must not defer tools the prompt promises are immediately available.                                                   |
| 4   | Portable helper retirement | Include extension-api consumer and shared export.                                             | Deleting only the server import leaves live broken callers.                                                                            |
| 5   | Extension schema support   | Keep its existing accepted subset.                                                            | Current in-memory record listing is not a product decision to widen the contract.                                                      |
| 6   | Parse equivalence          | Explicit prerequisite to a frozen execution specification.                                    | Measured counterexamples show naive full-object registration is not universally equivalent.                                            |
| 7   | Delivery                   | Internal `chore(...)` subject, no fragment, `skip-changelog`; normal review and verification. | Direct issue instruction; no gate waiver.                                                                                              |

No product ambiguities require a user decision. The current declarations are now pinned by the census and finite parsing proofs. SPECIFY carries that supported-contract boundary into the implementation and proof plan; it does not promise arbitrary new transform semantics. This IDEATE stage has not implemented or shipped the migration.
