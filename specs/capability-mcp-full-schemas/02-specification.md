---
slug: capability-mcp-full-schemas
number: 261116-033650
created: 2026-11-16
status: specified
---

# Register capability MCP tools with full input schemas

**Status:** Under Review  
**Author:** Codex  
**Date:** 2026-11-16  
**Issue:** [DOR-2067](https://linear.app/dorkspace/issue/DOR-2067)  
**Pinned source base:** `1cc1a721518d4287412ea1a6ef33e9283b576594`

## Overview

Register ordinary registry capabilities using full, strict Zod objects on the Claude in-process MCP server and external MCP server. Keep per-session exposure metadata, current argument/default behavior, authoritative registry execution and both approval delivery paths. Remove the obsolete portable raw-shape helper, its export and all living callers. This is an internal migration with no changelog fragment; the PR uses `skip-changelog` and a `chore(...)` subject.

## Background / Problem Statement

The original DOR-2053 failure was a bundled Zod reading a newer defaulted field as required. It does not reproduce on installed Claude Agent SDK `0.3.304`, MCP SDK `1.32.0`, Zod `4.6.7`: a raw defaulted field omitted from a real MCP call reaches the SDK handler with its value. Do not claim this migration fixes a present default failure.

The current raw-shape registration still discards object semantics. An ordinary unknown key or caller-supplied `ownerId` is silently removed before the handler. Full strict objects reject both before invocation and preserve object refinements. The principal-bound Claude registration already demonstrates full-object registration, but it is a distinct audience and input policy; ordinary registration must not copy its authority behavior.

The current composed-source census supplies every optional domain and enables the To-dos flag for coverage: **131 capabilities; 117 ordinary MCP capabilities in the union, 116 in-session and 84 external; 12 principal-bound runtime capabilities; 129 MCP-relevant declarations total.** Enumerate current declarations and `CONNECTOR_RUNTIME_CAPABILITY_IDS` in tests; these measured counts are a planning baseline, not a new production literal list.

Of the relevant schemas, two have outer preprocess pipes: `ui.send_canvas_event` and `ui.patch_canvas_state`. They are non-mutating JSON-bound checks and contain no substituting defaults. Fourteen capabilities have 15 top-level defaulted fields; including nested traits and MCP configuration, there are 29 default nodes. There are no prefaults and no value-changing transform nodes beyond the two bound preprocessors in the inspected current declarations. Recursive JSON source was also inspected; its lazy union does not substitute values.

Private planning evidence is in `.dork/flow/tmp/2067-ideate/`: current schema census, actual SDK listing/call probes, installed primary-source excerpts, and three green current-schema parsing probes. Their scope is stated below and must not become a claim of shipped integration.

## Goals

- Ordinary capability MCP tools register a full `ZodObject`; unknown top-level arguments are refused before registry execution.
- Omitted defaults, current numeric coercion, refinements and bounded canvas request semantics remain correct through actual SDK and registry execution.
- Preserve actual plain/agent exposure, hints, hidden filtering, fresh caller identity, audience, cancellation, cards, held approvals, external token/poll and warm tool-surface behavior.
- Delete `capabilityInputShape`, `portableInputShape`, the shared helper/export and obsolete capability-normalization guards after migrating every live consumer, including extension-api.
- Keep current service, permission, extension and SDK boundaries; provide meaningful independent proof.

## Non-Goals

- Native hand-tool parity (DOR-4481), a new extension-schema feature, widening the eager set, SDK upgrades, new gates, configuration or data migrations.
- Changing hand-registered tool parsing, the private capability audience, approval-token eligibility, annotations or tool names/descriptions beyond factual touched documentation corrections.
- Supporting arbitrary new non-idempotent transforms or prefault schemas. Synthetic counterexamples establish that naive full-schema registration is not universally equivalent; they do not establish a current product input defect.
- New registry parsed-input bypasses, a second privileged invocation path, a renamed portable shim, real-model inference, credential operations or paid runs.

## Technical Dependencies

- Installed `@anthropic-ai/claude-agent-sdk@0.3.304`: `tool()` creates exposure metadata; `createSdkMcpServer()` returns a real, not-yet-connected `McpServer` instance. Confine this import to the Claude runtime directory.
- Installed `@modelcontextprotocol/sdk@1.32.0`: full-object registration, actual `tools/list`, `tools/call` validation, abort signal and in-memory client transport.
- Installed `zod@4.6.7`: strict object clones preserve checks; additive `.extend()` and `.safeExtend()` preserve refinements. A refined `.extend()` throws when overwriting existing fields, not when simply adding a new key.
- Existing `CapabilityRegistry`, input projection, invocation wrapper, approval services, exposure policy and tool-surface digest. Do not change their authority model.

## Detailed Design

### 1. Full advertised schema

Replace the raw-map projection with a clearly named full-object helper in `core/capabilities/mcp-projection.ts`. Recover the existing advertised object with `capabilityInputObject(capability)`, obtain a strict object clone, and add the existing `approvalTokenArgument()` only when **the ordinary path's existing `canRaiseApproval(capability)` rule** says it may. Use an object API retaining refinements; do not rebuild an object from a spread of `.shape`. Do not mutate the executable capability input.

Keep outer preprocess pipes on the original registry schema, as today. Registration uses the advertised object; the existing registry parse remains responsible for the full executable schema, then permission/gate/hash/handler. No alternate invoke API or trusted marker is introduced.

Strictness closes the top-level argument object. It must not close nested JSON maps or rewrite coercion/default nodes. `approvalToken` continues riding beside input, then is removed by the existing wrapper before the original registry parse and binding. Do not change ordinary token eligibility or the private path's existing tier-based schema policy as a side effect.

### 2. Current parse-equivalence boundary

The new SDK parse can fill defaults earlier than the old portable projection. The supported current declarations are safe at that seam: their 29 default nodes are ordinary idempotent values; number coercion is idempotent; and neither outer bounded canvas object contains defaults or transforming values. Planning probes actually passed all 29 current default nodes through the real SDK and registry in observe fixtures that used the original field schemas. Both original canvas input schemas passed exactly **16,384 bytes** and refused **16,385 bytes** through the same SDK/registry path. These probes replace services with recording handlers and deliberately make no authority or production-handler claim.

Implementation must put durable tests at those real parsing seams. For canvas inputs, retain a valid exact-byte positive and a one-byte-over refusal before the recording service/handler. For nested traits and MCP connection defaults, provide actual input objects that prove values remain unchanged after registry parsing; for ordinary defaults, use real `list_capabilities` as a production capability positive alongside enumerated schema coverage.

Do not generalize to arbitrary executable schemas. The private synthetic probes measured a 39-byte bounded raw input becoming too large after default insertion, and a prefault transform becoming `seed!!` instead of `seed!`. There is no request to support those new declarations here. If implementation discovers a different current production schema or an accepted extension declaration with such behavior, stop the narrow migration and resolve that concrete declaration with the coordinator before changing its contract. No artificial compatibility shim or permission bypass is allowed.

### 3. Claude registration and metadata

Replace the ordinary raw-definition builder with direct registration on `server.instance` after `createSdkMcpServer()` creates the server. Keep hand tools in its existing `tools` array. Filter ordinary hidden tool names **before** registering them. Preserve capability order/names/descriptions and return `ToolSurfaceEntry` values containing the full schemas actually registered.

Reuse the current ordinary invocation callback: recover the SDK signal; assemble the same optional hold/card surface; resolve context on each invocation; retain `mcpServer: transport`; pass through the same shared wrapper. The current session/rekey, cwd, principal resolution and hand-tool reach logic in the factory remain authoritative. Do not capture a stale turn context.

Use the SDK's own `tool()` factory to generate exposure metadata from existing `toolExposure(name, title, alwaysLoaded)`, then carry its `_meta` into direct full-object registration. Creating that metadata descriptor does not register its raw shape. A narrow Claude-local helper may share this packing, but no private metadata key or eager-loading policy is copied across modules. Test the actual wire metadata against the factory output and current plain/registered-agent sets.

Preserve annotations **per existing path**. Ordinary Claude capability definitions currently pass exposure extras without derived annotations; private Claude and external capabilities derive annotations. Do not silently add ordinary annotations in this migration. Principal-bound registration retains its existing input, audience and context behavior; continue enumerating its current 12 IDs from the constant. Remove stale comments claiming five or seven where the module is touched, without introducing another count to maintain.

The factory records hand, ordinary and principal-bound schemas once each. Hidden tools must not reappear through the new direct registrar. Keep connector-tool inclusion stable across warm turns and per-call context fresh. `toolSurfaceDigest()` already handles full schemas: retain its stable sort and unchanged-build equality. The strict schema may legitimately change the launch digest once, causing the existing warm-process replacement behavior.

### 4. External MCP and helper retirement

Use the full advertised ordinary schema in `core/external-mcp/capability-mcp-tools.ts`. Preserve its hidden names, existing derived annotations, request-scoped context, selected server audience, abort forwarding and sessionless token/poll semantics. Never add an in-session hold or principal-bound private registration to `/mcp`.

Migrate the extension-api listability consumer from raw portable reconstruction to the full strict-object input contract. Keep the existing closed JSON Schema subset, reserved names, record/lazy/open-key refusals, bounds and helpful refusal reasons. Conversion of a record happens to work on the current SDK; that is not authorization to widen extension schemas. Full direct registration bypasses the SDK factory's per-definition unconvertible-schema disabling wrapper: a `z.date()` candidate was measured to fail the whole direct server's list. Preserve the accepted schema checks and prove a valid contributed declaration lists beside core tools while an unsupported sibling is rejected before registration.

Then delete the shared portable helper and subpath export. Migrate actual source/test callers of `capabilityInputShape`; preserve or replace behavior assertions instead of retaining dead aliases. Update living developer-guide references and touched comments. Historical ideation/spec references may retain historical names when clearly contextual; no surviving runtime/import/config reference may resolve a removed export.

Remove the capability raw-rung workaround tests. Keep real omitted/default behavior tests. Hand tools are parsed once and must receive no portable normalization; their existing raw-shape safety guard is a separate contract. Correct any touched explanation claiming the current SDK cannot parse raw defaults. This task does not relax a hand-tool guard merely because the capability workaround is removed.

### 5. API and data changes

Internal helper/registrar APIs change from raw builders to full-object registrations. Wire tool names and declared arguments stay the same, except that unknown top-level arguments now yield a real MCP validation refusal. No public HTTP route, stored schema, config field, database table or migration is added.

## User Experience

Agents keep the same immediately available tools and search hints, can call `list_capabilities` with omitted defaults, and receive ordinary tool results or existing approval cards. A call with an unknown argument receives an actionable SDK validation error naming that argument, rather than silently discarding it. Allowed ordinary calls still work beside refusal cases. Existing in-session approval holds resume after a decision; external MCP callers keep token/poll retries. No UI layout or app copy is added.

## Testing Strategy

Every new durable behavior test states its purpose. Real MCP transport and registry execution are preferred over a fake registration counter. Mock service/network/identity edges only where the existing fixture requires them; do not add own-module mocks or expose credentials.

| Proof             | Required boundary and meaningful subject                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defaults          | Actual SDK server → real MCP client → registry → recording or real safe handler; omitted/explicit values and advertised defaults; current top-level and nested declarations enumerated with a nonzero subject assertion.   |
| Strict input      | Valid ordinary call plus ordinary unknown key and authority-shaped key; both refused before that same handler or approval service. Removing `.strict()` must expose the intended failure.                                  |
| Refinements/token | Full object refinement survives token extension, original capability input stays unchanged; allowed token field is advertised, non-eligible field is not; existing held and external token/poll workflows remain distinct. |
| Canvas bounds     | Both original canvas inputs valid at 16,384 bytes and refused at 16,385 before recording handler, plus nested-map positives and current preprocessor/refinement negatives. No new parser or changed bound.                 |
| Exposure/listing  | Actual plain, registered-agent and principal-turn `tools/list`; current metadata, exact names, hidden filtering, annotations per path and one registration each. Removing metadata must fail the correct subjects.         |
| Warm state        | Repeated unchanged actual server builds produce equal digests; hidden/schema changes alter the appropriate digest; connector turn context changes use the current launch inclusion policy.                                 |
| Extension         | Accepted defaulted declared/contributed tool lists beside core tools and executes through registry; refused unsupported declaration never registers; current CLI/manifest validation behavior stays consistent.            |
| Retirement        | Whole-tree search including hidden configuration, source, package exports and living prose; actual relevant package build/typecheck catches broken consumers.                                                              |

Run the affected default, attribution, in-session card/hold, tier enforcement, exposure, tool-surface, input-projection, external MCP, extension and local-browser suites. Rebuild own dependencies when necessary; targeted typecheck/lint include server, spaces compilation, shared and extension-api as affected. Run normal hooks and the mandatory exact-head `pnpm verify` before PR delivery. Full verification and separate review use the final unchanged commit.

Concrete acceptance commands, run from this worktree as the affected implementation lands:

```bash
pnpm vitest run apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/mcp-default-arguments.test.ts apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/capability-mcp-tools.test.ts apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/tool-exposure.test.ts apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/tool-surface.test.ts
pnpm vitest run apps/server/src/services/core/capabilities/__tests__/input-projection.test.ts apps/server/src/services/core/capabilities/__tests__/mcp-projection.test.ts apps/server/src/services/core/capabilities/__tests__/mcp-tier-enforcement.test.ts apps/server/src/services/core/capabilities/__tests__/capability-approval-hold.test.ts apps/server/src/services/core/capabilities/__tests__/in-session-card.test.ts
pnpm vitest run packages/extension-api/src/__tests__/tool-check.test.ts packages/extension-api/src/__tests__/manifest-tools-schema.test.ts apps/server/src/services/extensions/__tests__/extension-agent-tools.integration.test.ts apps/server/src/services/core/external-mcp/__tests__/surface-parity.test.ts apps/server/src/services/core/external-mcp/__tests__/task-permission-mode.test.ts
pnpm --filter @dorkos/server typecheck
pnpm verify
```

These are future acceptance commands, not claims they ran during planning. New tests for the full registrar and current bounded schemas join the appropriate focused commands. The final full gate is run once on the immutable reviewed delivery head by the coordinator.

No browser suite is needed for this internal change unless execution adds UI behavior, which this specification does not. No model inference, paid-provider flag or auth flow is needed for these MCP contracts. Do not claim native-runtime or live-model proof from in-memory transport tests.

## Performance Considerations

Keep one registration and one digest serialization per listed tool; do not introduce repeated registry composition, model calls or another global cache. The schema contract changes at server construction; per-call identity remains fresh. Existing bounded JSON reads stay bounded. No latency/SLO claim follows from local probe timings, and no timeout, retry or test floor is relaxed.

## Security Considerations

Strict argument rejection improves honesty at the entry seam; it is not a new authority grant. Identity, principal, session, cwd, permission and audit facts remain server-owned. Preserve existing registry validation before gating/hash/execution, unmodified approval input binding, in-session held/card paths, external token/poll, hidden-name refusal and cancellation. Do not copy private capabilities onto the ordinary server or accept client authority selectors. No trusted marker, credential exposure or registry bypass is added. Nested maps required by current tools remain legal; arbitrary extension schemas stay refused by their existing subset.

## Documentation

Update touched projection/registration/default-workaround TSDoc to the actual pinned behavior, the live developer-guide token-projection reference, and extension listability comments when their helper is removed. Preserve historical bug descriptions as history where appropriate. No user-facing docs, marketing claims, changelog fragment or SDK support announcement are needed. The PR states `Closes DOR-2067` and uses `skip-changelog`, never `skip-review`.

## Implementation Phases

- **Phase 1 — schema contract and consumer preparation:** Introduce the full ordinary MCP schema helper with strictness/refinement/default/approval tests and prepare extension-api's full-object listability check. Keep still-used symbols only during the bounded migration; nothing obsolete remains in the final branch.
- **Phase 2 — registration and complete retirement:** Migrate Claude and external ordinary registration, using SDK-generated metadata and unchanged callbacks. Preserve private/hand paths, hidden filters and the complete digest. Convert affected source/tests to actual full registration, then delete the old raw helper, portable source/export and capability workaround guard only after every caller has moved. Update living references in the same completed change.
- **Phase 3 — proof and delivery:** Finish current-schema/extension/approval/exposure controls, whole-tree retirement sweep, targeted checks and separate `REVIEW.md` review; then clean final commit, full exact-head verification and PR/queue workflow. DOR-4485 remains a delivery dependency until actually resolved.

## Open Questions

- ~~(RESOLVED) Does the old raw-default failure still reproduce?~~ **Answer:** No on SDK 0.3.304/MCP 1.32.0/Zod 4.6.7. **Rationale:** Real raw default probe calls succeeded; the migration is for full schema semantics and obsolete-coupling retirement.
- ~~(RESOLVED) How are loading controls preserved?~~ **Answer:** Use the existing session policy and SDK factory-generated metadata on full registration. **Rationale:** Actual `tools/list` equality was measured; no private encoding needs a parallel implementation.
- ~~(RESOLVED) Does full registration need arbitrary new transform support?~~ **Answer:** No. Preserve the measured current production and supported extension contracts; no new parser path or renamed shim. **Rationale:** Current census and boundary/default probes settle the supported declarations; synthetic counterexamples are explicitly excluded new generality, not ignored present bugs.
- ~~(RESOLVED) Does helper deletion include extension-api?~~ **Answer:** Yes. **Rationale:** It has a live import; source/export removal without that migration would break consumers.
- ~~(RESOLVED) Is a new ADR required?~~ **Answer:** No. **Rationale:** This adopts the existing full-object MCP path and retains established registry, SDK confinement and approval decisions. It introduces no new technology, permission architecture or durable product policy. Repo rules also prohibit draft ADRs.

No operator decision remains. This specified artifact awaits the coordinator's review before DECOMPOSE and implementation.

## Related ADRs

- [260923-223905 — Permission decisions ride the tier gate](../../decisions/260923-223905-permission-decisions-ride-the-tier-gate.md): no fourth permission path.
- [260725-133221 — Approvals bind to the exact action shown](../../decisions/260725-133221-approvals-bind-to-the-exact-action-shown.md): registry parses once before the binding and handler; respect its later DOR-467 amendment.
- [260912-025252 — The UI capability domain](../../decisions/260912-025252-the-ui-capability-domain.md): shared capability bodies remain transport-neutral.

## References

- [DOR-2067](https://linear.app/dorkspace/issue/DOR-2067), [ideation](./01-ideation.md), the canonical Flow IDEATE/SPECIFY templates read from the installed plugin.
- `research/runtime-upgrades/claude-agent-sdk/0.3.280-to-0.3.304/impact-assessment.md` and installed dependency primary sources named above.
- Private planning proofs: `.dork/flow/tmp/2067-ideate/{sdk-probe,sdk-listability-probe,parse-ownership-probe}.{mjs,json,log}`, `schema-census.json`, `current-defaults-proof.json`, `current-canvas-proof.json`, `census-and-semantics-restored.log`. Three current-schema probes pass; one earlier extended probe collected zero cases because a private-file bare import could not resolve, then used the actual relative shared sources. It is not counted as product failure or green evidence.
