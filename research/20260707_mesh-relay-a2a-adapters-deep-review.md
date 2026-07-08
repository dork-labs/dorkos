# Deep Review: Mesh, Agent-to-Agent Communication, and Adapters

**Date:** 2026-07-07
**Scope:** `packages/mesh`, `packages/relay` (core + adapters), `packages/a2a-gateway`, server glue (`apps/server/src/services/{mesh,relay}`, routes, `index.ts` wiring), client UI (`features/mesh`, `features/relay`, `features/agent-settings` channels, `entities/{relay,binding}`).
**Method:** Five parallel deep-review agents (code, architecture, DX, UX), each reading full source plus ADRs/docs/tests. All findings below were verified against actual code by the reviewing agent; file:line references included.

## Verdict

The subsystem designs are good — clean decomposition, excellent TSDoc, real security craftsmanship in places (webhook HMAC, credential masking, atomic-rename dedup). But the **seams between components are where everything breaks**: the A2A gateway is integration-broken in production, the relay's documented async agent-to-agent workflow cannot work, the mesh reconciler has a silent data-loss path, and the client's three binding surfaces drift into silent no-ops (including a security-relevant one). A recurring root cause: **unit tests mock both sides of a contract incorrectly, so CI is green while the shipped path is broken.** Cross-seam integration tests are the single highest-leverage structural investment.

## Cross-cutting themes

1. **Contract drift at seams, hidden by mocks.** A2A executor expects a payload shape nothing publishes; `relay_inbox` returns rows without the payloads its own tool docs promise; the client's `useUpdateBinding` type omits `permissionMode` so edits silently drop; A2A unit tests hand-craft envelopes that don't match the real CCA adapter output.
2. **Built but never wired.** `AdapterStreamManager` (ADR-0179/0209) has zero production call sites; topology enrichment deps (`taskStore`, `relayCore`) are never passed at the production mount so relay badges/task counts are dead; `BudgetMapper` and manifest budgets are decorative; the graph's ghost "Add Adapter" node is a no-op on the only page that renders it; A2A cancel path is unreachable dead code.
3. **Doc/ADR drift.** ADR-0043 ("rebuild DB from files") is false — the reconciler can't discover; ADR-0032's namespace example yields the wrong namespace in the shipped product; ADR-0081's send-and-wait progress design isn't what's implemented; ADR-0179's stream manager isn't used; a2a-gateway README doesn't compile; adapter-catalog.md describes telegram-chatsdk behavior that isn't real.
4. **No garbage collection / lifecycle hygiene.** Relay index and maildirs grow forever; persistent inboxes brick at 1000 messages; noop subscriptions accumulate every restart; task-file watchers leak on unregister; adapter start-timeout leaks running adapters.
5. **Tolerated legacy contradicting the project's own standard.** `telegram-chatsdk` (deprecated, ~900 LOC duplicate), legacy `createMeshRouter` single-arg overload (the one production uses), dead mesh types/shims, duplicate relative-time helpers and status palettes, duplicate BindingDialog test files.

---

## 1. Relay core (internal A2A)

### Critical

- **C1 — Persisted subscriptions restored as noop handlers destroy messages after restart.** `subscription-registry.ts:321-347` restores every pattern from `subscriptions.json` with `noopHandler`; these count as real subscribers in `delivery-pipeline.ts:213-247` (claim → noop → complete deletes the message) and `relay-publish.ts:303-315` (noop "success" skips pending-buffer and DLQ). Every restart appends more permanent noop entries; window between RelayCore construction and BindingRouter.init() eats inbound platform messages. Fix: don't restore persisted patterns as active; prune stale ids; question whether subscription persistence earns its keep.
- **C2 — `relay_inbox` returns no payload; the documented `relay_send_async` polling workflow cannot work.** `sqlite-index.ts:79-103` never writes payload; `relay-tools.ts:44-62` returns raw index rows, but the `<relay_tools>` prompt (context-builder.ts) promises `{type, text, done}` events. No ack tool exists, so `unread` never transitions. Fix: join to maildir `readEnvelope` (or persist the payload column) + add claim/complete.

### High

- **H1 — `relay_send_and_wait` subscribes after a publish that blocks on the whole agent turn** (`relay-tools.ts:129-192`, `relay-publish.ts:256-264`). Progress events land on a zero-subscriber inbox and are lost (contradicts ADR-0081); final reply delivery is a chokidar timing coincidence; turns >120s get dead-lettered as "failed" while the agent still works. Fix: subscribe before publish, drain `new/` on subscribe, make `relay.agent.*` adapter delivery fire-and-forget. (The roundtrip test subscribes first, masking the bug.)
- **H2 — Rate limiter erases its own accounting.** DLQ and adapter-delivery `insertMessage` upserts null out `sender`/`expiresAt` for the same envelope id (`dead-letter-queue.ts:144-151`, `adapter-delivery.ts:61-70`, `sqlite-index.ts:91-101`) — agent-to-agent sends are effectively never rate-limited.
- **H3 — `relay_send` reports rate-limited drops as `queued: true`** (`relay-tools.ts:26-30`) — `rejected[]` discarded; agent told success on a drop.
- **H4 — No GC anywhere.** `deleteExpired()` has no scheduled caller; no maildir `new/` sweep; persistent inboxes hit `maxMailboxSize` (1000) and then reject all deliveries permanently.

### Medium

- **M1** — Crash between claim and complete strands messages in `cur/` forever; `rebuildIndex` mislabels them `delivered` (`maildir-store.ts:172-191`, `sqlite-index.ts:298-302`). At-least-once silently downgraded.
- **M2** — `Promise.all` over subscribers: one failing handler fails the message for all and trips the endpoint circuit breaker for a consumer bug (`delivery-pipeline.ts:235-246`). `halfOpenProbeCount` is dead config.
- **M3** — `unregisterEndpoint` rm -rf's unread mail + DLQ forensics; 30-min TTL sweeper deletes actively-polled dispatch inboxes (`endpoint-registry.ts:96-107`, `relay-core.ts:404-417`).
- **M4** — CCA semaphore counts queued work; 4th concurrent message to one agent is rejected → dead-lettered (`claude-code-adapter.ts:236-244`).
- **M5** — Envelope ID ≠ maildir ID ≠ index ID; `getMessage(publishResult.messageId)` returns a placeholder row hardcoded `delivered`.
- **M6** — `from` is self-declared by the LLM (`relay-tools.ts:433`); access control default-allow; namespace deny rules bypassable by claiming another `from`. Inject identity server-side.
- **M7** — `relay_notify_user` picks the _last_ binding, not the most recently active chat (`relay-tools.ts:377-383`).
- **M8** — `relay.agent.*` slot-3 grammar collision (mesh namespace vs runtime type vs agentId), disambiguated by a UUID heuristic (`lib/subject-parser.ts:108-134`).

### Low

Watcher error pre-`ready` hangs `registerEndpoint`; no fsync on publish; DLQ delete-via-poisoned-row hack; deprecated `/stream` SSE silently skips events under backpressure; `sessionQueues` leak in runtime-adapter; CCA replies reset budget/ancestry each hop; `PublishResult` duplicated in two files.

---

## 2. A2A gateway (external A2A)

### Critical

- **F1 — Executor never emits the initial `Task` event the SDK requires** (`dorkos-executor.ts:122-258`). Nothing is ever persisted; `tasks/get`/`tasks/cancel` always fail; the cancel path is unreachable dead code; contextId multi-turn impossible; error statuses are discarded and surface as opaque `-32603` (F3).
- **F2 — Reply contract mismatch with the actual internal responder.** Executor settles on the first envelope and casts to `StandardPayload`; the CCA handler streams raw `StreamEvent`s per event (`agent-handler.ts:235-245`) — first `text_delta` "completes" the task with `text: undefined`. Nothing in the codebase publishes what the executor expects. Unit tests hand-craft the wrong shape, so CI is green.

### High

- **F4** — Agent card served at `/.well-known/agent.json`; spec + SDK client use `/.well-known/agent-card.json` — standard clients 404 on discovery (`apps/server/src/index.ts:754`).
- **F5** — Routing needs undocumented `metadata.agentId`; without it, falls back to `agentRegistry.list()[0]` (arbitrary, plausibly DorkBot). Every per-agent card advertises the same URL.
- **F6** — All external callers share one long-lived agent session (keyed on mesh ULID, `contextId` ignored) — cross-caller context bleed and prompt-injection persistence.

### Security

`mcpApiKeyAuth` passes through unauthenticated when no key/login configured — safe only because of the localhost default; `DORKOS_HOST=0.0.0.0` exposes unauthenticated prompt execution against every agent. No rate limiting, binary authorization (any identity commands every agent incl. DorkBot), authenticated user discarded (`UserBuilder.noAuthentication`), security scheme advertises `apiKey` where clients expect `http/bearer`.

### Medium/Low

`working` status can publish after completion (no `settled` guard, `dorkos-executor.ts:243`); cancel is cosmetic + 5s marker vs 2-min window race; 2-min timeout vs CCA 5-min default mismatch; DB status enum missing `rejected`/`auth-required`; unguarded `JSON.parse` on history rows; no task retention; mount-time card snapshot never refreshes; file/data parts silently dropped to empty prompt; `relayStatusToTaskState` dead export; README API doesn't compile; card baseUrl can be `http://0.0.0.0:4242` with no HTTPS/proxy override. Zero test coverage of a successful `message/send` through the real JSON-RPC layer.

---

## 3. Adapter system (framework + Telegram + Slack)

### High

- **H1 — Slack channel @mentions processed twice.** Both `app.message` and `app.event('app_mention')` fire with distinct `event_id`s; dedup misses → duplicate agent invocations (`slack-adapter.ts:140-172`, `inbound.ts:390-412`). Fix: dedup on `channel:ts`.
- **H2 — Telegram splits AFTER Markdown→HTML conversion** (`telegram/outbound.ts:151-158`) → chunks with unbalanced tags → Telegram 400 → entire multi-chunk delivery fails for any formatted response >4096 chars. `TELEGRAM_MAX_LENGTH=4000` margin constant exists but is unused; fence re-open can exceed the limit. Same bug duplicated in telegram-chatsdk.
- **H3 — Telegram approval card uses legacy `parse_mode: 'Markdown'` with unescaped tool input** (`outbound.ts:492-510`) → 400 → approval never delivered → tool call hangs to timeout with no user signal.
- **H4 — Polling reconnect drops the `callback_query` handler** (`telegram-adapter.ts:454-476`) — approval buttons dead after any network blip. Fix: shared `wireBot()`.
- **H5 — `AdapterStreamManager` never wired in production** — dead subsystem (ADR-0179/0209) with a latent group-chat threadId bug if ever wired. Wire it or delete it and the `deliverStream` surface.

### Medium

- **M1** — Registry start-timeout never stops the still-starting adapter → unmanaged polling loop, 409 conflicts on reload (`adapter-registry.ts:86-104`).
- **M2/M8** — `BaseRelayAdapter.start()` doesn't guard `starting` state and doesn't `_stop()` on `_start` failure → double polling loops, leaked signal subscriptions.
- **M3** — Slack module-level caches violate the multiInstance rule; stopping one instance wipes dedup for all (`slack/inbound.ts:74`).
- **M4/M5** — Slack streamed responses truncated at 4000 chars (non-streamed path splits properly); native streaming formats isolated deltas → mangled markdown at chunk boundaries.
- **M6** — **Approval buttons have no authorizer check** — any member of a bound group chat can approve tool execution (`telegram-adapter.ts:212-255`, `slack-adapter.ts:341-414`). Needs binding-level approver allowlist.
- **M7** — Slack `signingSecret` required but never used (Socket-Mode-only) — users hunt a credential that does nothing.

### Low

Telegram formatting instructions tell agents `_italic_` but converter doesn't handle underscores; webhook missing-nonce degrades to confusing 24h replay rejection; Telegram webhook-mode placeholder URL is a misconfiguration trap (separate server on 8443, not the Express route); `AdapterManager.buildContext` hardcodes `runtime: 'claude-code'`; chatsdk outbound has no 429 handling; docs drift in adapter-catalog.md and relay-adapters.md.

### telegram-chatsdk verdict

**Delete it.** Its own manifest says `deprecated: true` ("use the Telegram adapter instead"); grammy adapter is strictly superior; chatsdk bypasses the Chat SDK for all outbound anyway; it duplicates inbound/outbound/split logic (with a worse `splitMessage`); the client already hides it from the Add Adapter catalog. Remove: adapter dir, `AdapterTypeSchema` enum value, factory case, codec, barrel exports, both doc sections; add a startup warning/config migration for existing `type: 'telegram-chatsdk'` instances.

### DX (adapter authors)

Strong on paper: `BaseRelayAdapter` well-TSDoc'd, plugin convention simple, `validateAdapterShape` errors precise, 1,812-line contributing guide, testing kit exported. Weak in practice: the compliance suite would not have caught any High finding above (no echo-loop, splitting, 429, approval, or timer-leak checks) and isn't run against telegram or slack — only webhook and the deprecated chatsdk. The hardest real-adapter concerns (StreamEvent buffering, echo prevention, thread-id codecs, platformData threading conventions) must be reverse-engineered from grammy, with a contradictory second reference implementation nearby. Plugin loading is arbitrary `import()` — fine locally (ADR-0030) but undocumented as a trust boundary.

**Positives:** webhook HMAC is textbook (timing-safe, dummy compare, ±300s window, nonce TTL, dual-secret rotation); `maskSensitiveFields`/`mergeWithPasswordPreservation` correct; binding routing default-deny most-specific-first; echo prevention everywhere; hot-reload is start-new-before-stop-old.

---

## 4. Mesh

### High

- **#1 — Reconciler permanently deletes agents whose paths come back.** `markUnreachable` is never cleared when the path returns (sync uses `update()`, which doesn't touch status), and the removal sweep never re-checks accessibility (`reconciler.ts:62-109`). Unmount a volume over a weekend → agent removed from DB + Relay even though `.dork/agent.json` is back. No resurrection tests exist.
- **#2 — Task-watcher cleanup on unregister always no-ops.** `onUnregisterCallbacks` fire after `registry.remove()`, so `getProjectPath()` is always undefined in the `index.ts:617-637` callback → chokidar watchers + reconciler dirs leak per unregister. (`orphaned-installs.ts:27-28` documents the exact trap; `routes/mesh.ts:505-508` gets it right.)
- **#3 — Production never wires topology enrichment.** `index.ts:705` mounts legacy `createMeshRouter(meshCore)` — `taskStore`/`relayCore` undefined, so the topology UI's relay badges and task counts (`AgentNode.tsx:125-147`) are permanently dead in the shipped product.

### Medium

- **#4** — `listWithHealth` ignores the `unreachable` status column; `/api/mesh/status` and `/api/mesh/agents` contradict each other.
- **#5** — MCP mesh tools (also exposed on external `/mcp`) skip boundary validation and force-cast `runtime` → can write schema-invalid manifests that then `safeParse` to `null` forever (permanent divergence).
- **#6** — Auto-import namespace derivation throws for agents outside `defaultScanRoot` (namespace omitted by agents-route/agent-creator manifests) → kills the entire discovery scan.
- **#7** — `upsert` path-conflict eviction is DB-only: leaks the evicted agent's relay endpoint, skips onUnregister cascade.
- **#8** — `enabledToolGroups` hardcoded `{}` in every DB read — mesh API reports wrong data; admitted half-finished migration.
- **#14 — ADR-0043 drift:** reconciler iterates `registry.list()` only — a wiped DB rebuilds to zero agents; "rebuild from files" is false in ADR, rules doc, and mesh.mdx.
- **#15 — ADR-0032 drift:** scan roots never travel through HTTP registration; `defaultScanRoot` is always homedir → namespaces collapse to "first dir under $HOME" → default-deny cross-namespace ACLs degenerate to allow-everywhere for typical layouts.
- **#16** — Cross-namespace topology reverse-engineered by regex from relay rule strings — most fragile seam in the package; consider a first-class rule store projected into relay.

### Low

Unregister has no compensation (relay throw → permanent zombie DB row with manifest already deleted); concurrent `update()` loses writes; reconciler reconstructs relay subjects without the basename fallback (subject string triplicated — extract `subjectFor(entry)`); `RelayBridge.registerAgent` early-return skips re-asserting access rules; BudgetMapper race + 61-bucket window (moot — zero production callers); dead types/shims (`DiscoveryScanOptions`, `discovery-strategy.ts` shim, stale doc refs); `GET /api/mesh/agents` returns two silently different shapes (topology path leaks `projectPath`); scan hot loop does sync `realpathSync` + per-dir queries; `readManifest` swallows validation failures silently.

### DX

Module decomposition clean and testable; TSDoc consistently explains _why_; adding a discovery strategy is genuinely easy (45-line interface, ten examples) though undocumented in `contributing/`. ~5,000 lines of tests, but blind exactly where the bugs are: unreachable-recovery, production wiring, callback ordering. Biggest respect-cost for a source-reading architect: documented guarantees that aren't true (ADR-0043/0032, topology badges, `enabledToolGroups`).

---

## 5. Client UI (topology graph, channels, connections)

### High

- **UX1 — ConnectionsTab "Add Binding" and "Advanced…" are dead ends** — both open create mode, but the dialog only renders for edit mode; includes a `toast.error('Unexpected create from ConnectionsTab')` jargon branch.
- **UX2 — Graph drag-to-bind silently discards configuration.** `handleBindingConfirm` (`use-topology-handlers.ts:180-192`) forwards only `{sessionStrategy, label}` — permissionMode (incl. confirmed Full Access), chat filter, direction toggles all dropped; dialog opens with empty pickers despite the drag, and selections are then ignored.
- **UX3 — Editing permission mode from ChannelsTab is a silent no-op** (security-relevant). `useUpdateBinding`'s `Pick` omits `permissionMode`; dirty-tracking includes it, so Save + "Binding updated" toast + no change — including after confirming the "Enable Full Access" warning. Believing you revoked full access when you didn't. (ConnectionsTab bypasses the type unsoundly, so the same edit works there.)
- **UX4 — One-character className bug kills drag-to-connect feedback:** `` `...inset-0${connectingFrom ? 'is-connecting' : ''}` `` (`TopologyGraph.tsx:255`) — missing space produces `inset-0is-connecting`: feedback CSS never applies AND the container loses `inset-0` mid-gesture.

### Medium

Edge-X/Backspace binding delete: immediate, unconfirmed, no error handling (every other surface confirms + toasts); Backspace also removes agent nodes locally; ghost "Add Adapter" node is a no-op on AgentsPage (callbacks never passed); full-screen spinner remount on every structural change resets viewport/zoom; "Binding: Telegram to " dangling copy (no agentName); "Last received Xm ago" frozen (interval ticks but `useMemo` deps miss it).

### Low / A11y / Consistency

Wizard shows Skip+Continue doing the same thing; copy references nonexistent "Bindings/Adapters" tabs; vocabulary drift (binding/channel/connection; three divergent status palettes and state labels); AccessView off-design-system (native select, deny-row-on-delete confusion); `role="img"` on the interactive canvas; missing focus-visible rings; no keyboard alternative to drag-connect; stale create-dialog state on cancel; AdapterSetupWizard not responsive-dialog.

### Code / FSD

`useUpdateBinding` type unsound in both directions; FSD violations — ChannelsTab + ConnectionsTab import `features/mesh/ui/BindingDialog` by internal path (barrel TSDoc claims it's encapsulated); `ChannelBindingCard` imports `mesh/lib/build-preview-sentence` cross-feature; `mesh/ui/AgentCard.tsx` dead (only dev showcase); duplicate BindingDialog test files; three duplicate relative-time helpers; `QuickBindingPopover` cmdk `value` collides on duplicate display names; `onSelectAgent` wired to `onViewHealth`.

### State/data

No SSE path for adapter status or bindings — polling only; `useBindings` has no refetchInterval and no event invalidation (cross-client changes never appear until a local mutation). Within one client, consistency holds via the shared `['relay','bindings']` cache key. `useToggleAdapter` optimistic update with rollback is correct. Binding mutations lack entity-level error toasts (each feature hand-rolls; the graph forgot).

### Consistency verdict

Three-and-a-half surfaces (graph, ConnectionsTab, ChannelsTab, wizard bind step), three mental models — divergent defaults, editability, confirmation, feedback, vocabulary. Fix is architectural: promote the binding form model (values type, submit mapping, preview sentence, labels/colors) to `entities/binding`; adopt ChannelsTab's "channel" outcome language everywhere.

**Positives:** ChannelsTab's progressive four-state empty states; preview-sentence pattern; honest bypass-permissions warning copy; credential sentinel + paste-trimming in ConfigFieldInput.

---

## Ordered work list

**P0 — broken core flows and silent data loss**

1. **Relay: fix the delivery-loss cluster.** Noop persisted subscriptions (C1), `relay_inbox` payloads + ack (C2), `relay_send_and_wait` subscribe-before-publish + non-blocking `relay.agent.*` delivery (H1). This is the internal A2A backbone; today it silently eats messages.
2. **A2A gateway: make it actually work.** Emit the initial Task event (F1), fix the reply contract with the CCA adapter + Zod-validate (F2), serve the card at `/.well-known/agent-card.json` (F4). Add one real integration test through the JSON-RPC layer with a fake relay responder.
3. **Client: make binding writes honest.** `permissionMode` in `useUpdateBinding` + both call sites (UX3 — security-relevant), forward full form values from graph create (UX2), render create mode in ConnectionsTab (UX1), the one-character className fix (UX4).
4. **Mesh: reconciler + wiring.** Unreachable→recovered transition + accessibility re-check before removal (#1); fire onUnregister callbacks with the pre-removal project path (#2); mount `createMeshRouter({meshCore, taskStore, relayCore})` and delete the legacy overload (#3).
5. **Adapters: outbound + dedup fixes.** Telegram split-before-format + 4000 margin (H2), approval cards in HTML mode with escaping (H3), reconnect `wireBot()` (H4), Slack `channel:ts` dedup (H1).

**P1 — security hardening**

6. **A2A external surface:** refuse/warn on non-loopback + pass-through auth, rate limiting, per-agent endpoints or reject agent-less requests (F5), session keying on `contextId` (F6), `http/bearer` security scheme.
7. **Approval authorization:** binding-level approver allowlist for Telegram/Slack approval buttons (M6) — today any group member can approve tool execution.
8. **Identity + boundaries:** inject relay `from` server-side (relay M6); boundary-validate + schema-validate MCP mesh tool inputs (mesh #5); validate in `writeManifest`, log in `readManifest`.

**P2 — lifecycle, GC, and legacy removal**

9. **Relay GC + accounting:** scheduled `deleteExpired` + maildir sweep in lockstep (H4), upsert preserves `sender`/`expiresAt` (H2), `cur/` crash recovery (M1), honest `relay_send` results (H3).
10. **Adapter lifecycle:** start-timeout stops the adapter (M1), `starting`-state guard + `_stop()` on `_start` failure (M2/M8), Slack instance-scoped caches (M3), streamed-response splitting (M4).
11. **Delete superseded code:** telegram-chatsdk (full removal + config migration), AdapterStreamManager decision (wire or delete), mesh dead types/shims/no-op flags, BudgetMapper (wire into relay dispatch or drop manifest budget fields), client dead code (AgentCard, duplicate tests/helpers).

**P3 — architecture, consistency, DX**

12. **One binding model in the client:** promote dialog/form/preview/labels to `entities/binding`, fix the three internal-path imports, unify vocabulary ("channel") and status palettes; graph interaction hardening (delete confirm, keep ReactFlow mounted, error toasts, wire ghost-node callbacks).
13. **Make the ADRs true or honest:** reconciler disk discovery for ADR-0043 (walk `${dorkHome}/agents/` + scan roots) or correct the docs; plumb scan roots through registration for ADR-0032 namespaces; align ADR-0081 with the fixed send-and-wait; update adapter/A2A docs + a real "Integrating via A2A" guide with a working client example.
14. **Test the seams:** cross-component integration tests (A2A→relay→CCA roundtrip, restart-with-persisted-subscriptions, Slack mention double-event, Telegram >4096 formatted message, reconciler resurrection, production router wiring); harden the adapter compliance suite (echo, splitting, 429, approvals) and run it on telegram + slack.
15. **Subject grammar + identity unification:** one canonical `relay.agent.*` grammar with an explicit discriminator (M8), envelope.id as maildir filename (M5), `subjectFor(entry)` helper; first-class namespace rule store projected into relay (mesh #16).
16. **UX polish:** live binding/adapter updates over SSE, frozen relative-time fix, a11y pass (focus rings, canvas role, keyboard binding creation), copy fixes, AccessView onto the design system.
