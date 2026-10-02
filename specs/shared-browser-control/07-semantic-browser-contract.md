---
slug: shared-browser-control-semantic-contract
created: 2026-10-01
status: specified
---

# Shared browser semantic contract

**Status:** Frozen design contract after the two distinct independent composition reviews at `17d7c579c0a52211521a2ce50de29b47f8142a1d` (journals44/45). This is design acceptance within the authorized scope, not implementation or evidence of assistive-technology readiness.

This supplies the semantic transport and action design requested by §Detailed Design
and §Open Questions of `06-production-specification.md` in the parent checkout.
Design freeze does not accept any runtime/identity configuration or the still-proposed ADR amendment.
The frozen prototype remains an experiment: `/semantic` emits a bounded outline,
while its keyboard buttons act on the canonical Page through control arbitration.
It does not implement the node identities, privacy policy, editing model, or
assistive-technology contract below. No Chromium or native probe accompanies this draft.

## 1. Boundary and supported scope

The private browser engine owns extraction and exact DOM bindings. The server owns
authenticated owner/actor context, grants, stream delivery, control epochs and the
serialized action queue. Browser-safe Zod schemas live in the proposed
`packages/shared/src/browser-schemas.ts`; Transport gains semantic read/subscribe
methods and submits semantic actions through the existing managed-browser action
method. Neither HTTP nor capabilities expose a Page, protocol session, JavaScript,
selector, backend node ID, execution context, profile path or arbitrary CDP command.

Version 1 supports Chromium accessibility trees, native plain-text input/textarea
editing, canonical focus, bounded keyboard commands and keyboard activation of
focusable buttons, links, checkboxes, radios and switches. Other accessible content
can be read; unsupported widgets are explicitly read-only or focus-only. Rich-text
editing, selection across multiple elements, native IME fidelity, operating-system
clipboard, platform dialogs and automatic widget-specific behavior are separate
acceptance work. Unsupported semantics never turn into an arbitrary click or
JavaScript evaluation. Pixel input remains independently authorized on the same Page.

The app renders typed data using owned components and escaped text. It never inserts
remote HTML, CSS, URLs, scripts, attributes, `aria-owns` IDs or live-region markup into
the authenticated app origin. This is a remote-page interface, not a cloned website.

## 2. Authority and identity

`browser.view` grants access to both pixels and sanitized semantics for an explicitly
owned/shared tab. `browser.control` additionally permits canonical focus and input
only while that authenticated actor is the controller. Browsing the local semantic
outline does not move the remote Page's focus. Session ownership or room membership
alone grants neither access; every request, stream delivery and queued dispatch
rechecks the owner-qualified grant and attachment. IDs are references, not authority.

Secret-field input additionally requires an explicit owner-issued
`browser.secretInput` grant. It is write-only, available only through a clearly
labeled password editor, and never returns the existing value. `writeSecret` is its only text-write operation;
plain-text operations refuse secret fields. Effective `grantRevision` changes
whenever view/control/secret-input permissions change; secret dispatch also pins
the exact secret grant and revision internally. The same focused-field
policy must apply to the pixel/keyboard lane, preventing a semantic-only restriction
from being bypassed through raw keys. Actor kind and identity come from trusted
credentials; request bodies cannot claim to be an owner, human or another agent.

All counters below are nonnegative safe integers; exhaustion stops the semantic
instance and creates fresh identities. Opaque IDs are server-random, at least 128 bits,
maximum 64 ASCII characters, never selectors or protocol identifiers.

| Binding                                | Lifetime and required comparison                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `ownerId`, `actorId`                   | Trusted server context; never accepted from a body.                                           |
| `semanticLeaseId`                      | Server-issued snapshot lease bound to actor, exact grant and attachment; at most two seconds. |
| `grantId`, `grantRevision`             | Exact current grant, expiry and scope; checked before reading and dispatch.                   |
| `browserId`, `browserGeneration`       | One live browser instance; restart never silently rebinds an old ID.                          |
| `tabId`, `navigationGeneration`        | Exact canonical Page and committed main document.                                             |
| `frameId`, `frameNavigationGeneration` | Engine-issued frame lifetime/document, including cross-origin subframes.                      |
| `viewportVersion`                      | Canonical viewport, independent of viewer size or zoom.                                       |
| `treeId`, `treeRevision`               | Semantic instance and published revision; any dirty tree refuses old references.              |
| `nodeRef`                              | Random reference scoped to that exact tree revision and frame document.                       |
| `epoch`, `inputGeneration`             | Current controller epoch and held-input reset generation.                                     |
| `focusRevision`                        | Exact canonical focus/selection binding for edit or keyboard requests.                        |

Reads of an unchanged, verified current tree reuse its engine node references and
revision, issuing only a fresh actor-specific lease. They do not revoke another
viewer's unexpired lease. A dirty generation publishes a new revision/reference
set even when visible labels happen to match; old references are never rebound.

A backend ID is only an internal lookup hint. A private binding also records the
protocol target/session, document, connected DOM object and validated role/edit kind.
Replacing a DOM element with identical text, role, ID or position cannot inherit its
reference. Name-based locators and Playwright snapshot `ref` strings cannot retarget
an issued action to a replacement element.

## 3. Versioned wire shapes

All JSON objects are strict: reject unknown keys, duplicate references, cycles,
non-finite coordinates, out-of-range counters and unknown enum values. Schema version
is negotiated before subscription; an unsupported major version fails explicitly.
The abbreviated types specify fields, not permission to accept arbitrary strings.

```ts
type SemanticIdentityV1 = {
  version: 1;
  browserId: string;
  browserGeneration: number;
  tabId: string;
  navigationGeneration: number;
  viewportVersion: number;
  treeId: string;
  treeRevision: number;
  epoch: number;
  inputGeneration: number;
  grantRevision: number;
  semanticLeaseId: string;
};

type SemanticNodeV1 = {
  nodeRef: string;
  frameId: string;
  frameNavigationGeneration: number;
  parentRef: string | null;
  childRefs: string[];
  role: SemanticRoleV1;
  name: string;
  description?: string;
  text?: string;
  value?: string; // Only eligible nonsecret plain-text editors.
  states: {
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    checked?: boolean | 'mixed';
    expanded?: boolean;
    selected?: boolean;
    pressed?: boolean | 'mixed';
    invalid?: boolean;
    level?: number;
    focused?: boolean;
  };
  editKind: 'none' | 'plainText' | 'secret' | 'unsupported';
  actions: SemanticActionKindV1[];
  redacted: boolean;
  truncated: boolean;
};

type SemanticSnapshotV1 = SemanticIdentityV1 & {
  capturedAt: string; // Informational UTC; server monotonic clock controls expiry.
  expiresInMs: number;
  rootRefs: string[];
  nodes: SemanticNodeV1[];
  focusedRef: string | null;
  focusState: 'node' | 'none' | 'unmapped';
  focusRevision: number;
  completeness: 'complete' | 'truncated' | 'unavailable';
  reason?: 'limit' | 'unstable' | 'unsupportedFrame' | 'engineUnavailable';
};

type SemanticActionV1 = {
  requestId: string;
  identity: SemanticIdentityV1;
  frameId: string;
  frameNavigationGeneration: number;
  nodeRef: string;
  focusRevision: number;
  eventStreamId?: string; // Required for edits; prohibited for other actions.
  action:
    | { kind: 'focus' }
    | { kind: 'activate' }
    | { kind: 'toggle' }
    | { kind: 'insertText'; text: string }
    | { kind: 'replaceText'; text: string }
    | { kind: 'writeSecret'; mode: 'insert' | 'replace'; text: string }
    | { kind: 'key'; key: SemanticKeyV1 };
};
```

`SemanticRoleV1` is the closed set `document`, `frame`, `generic`, `text`, `heading`,
`paragraph`, `link`, `button`, `textbox`, `checkbox`, `radio`, `switch`, `combobox`,
`listbox`, `option`, `list`, `listitem`, `table`, `row`, `cell`, `columnheader`,
`rowheader`, `tablist`, `tab`, `tabpanel`, `menu`, `menuitem`, `dialog`, `alert`,
`status`, `navigation`, `main`, `region`, `form`, `group`, `separator`, `slider`,
`spinbutton`, `progressbar`, `tree`, `treeitem` and `unknown`. Internal Chromium roles
map to this vocabulary; an unknown role is read-only. `SemanticActionKindV1` is the
seven action kinds above. `SemanticKeyV1` is `Tab`, `ShiftTab`, `Enter`, `Space`,
`Escape`, arrows, `Home`, `End`, `PageUp`, `PageDown`, `Backspace` or `Delete`.
No free-form shortcut, accelerator, system key or executable string is accepted.

## 4. Transport, delivery and resynchronization

Use authenticated `GET /api/browser/tabs/:tabId/semantic` for a fresh snapshot and
`GET /api/browser/tabs/:tabId/semantic/events` for non-durable notifications.
The stream uses strict `SemanticEventV1` objects with exactly `version: 1`,
`sequence: SafeInt`, `eventStreamId: string`, `identity: Omit<SemanticIdentityV1, 'semanticLeaseId'>`,
`type` and `reason`, plus the conditional payload below. Only `dirty` or `focusChanged/selectionChanged` may also have
`editRequestId: string`: the initiating actor receives it for an exact expected edit
transition observed during that actor's one in-flight request. Other actors receive
the ordinary uncorrelated event. The stream ID is server-issued, actor/grant/attachment
bound; sequence is monotonic within it. An edit must name its live authorized stream,
and correlation is delivered only there. This field contains no input and is not retained
in the shared resume ring; a gap always resets. It never issues an action lease. `revoked` uses the last authorized identity and immediately closes the stream.

| Event type       | Closed reason values                                                                       | Additional payload |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------ |
| `ready`          | `initial`, `refreshed`                                                                     | None.              |
| `dirty`          | `domChanged`, `axChanged`                                                                  | None.              |
| `focusChanged`   | `focusChanged`, `selectionChanged`                                                         | `focus` only.      |
| `reset`          | `navigation`, `frameChanged`, `viewportChanged`, `inputReset`, `streamGap`, `leaseExpired` | None.              |
| `controlChanged` | `acquired`, `takenOver`, `handedOff`, `disconnected`                                       | `control` only.    |
| `revoked`        | `grantRevoked`, `grantExpired`, `scopeRemoved`, `ownerDeleted`                             | None.              |
| `unavailable`    | `limit`, `unstable`, `unsupportedFrame`, `engineUnavailable`                               | None.              |

`focus` has exactly `frameId: string|null`, `frameNavigationGeneration: SafeInt|null`,
`focusedRef: string|null`, `focusRevision: SafeInt` and `focusState: 'node'|'none'|'unmapped'`.
`node` requires nonnull frame/ref; `none` requires null frame/ref; `unmapped` requires
null ref and a known nonnull frame. `control` has exactly `controllerId: string|null`
and `status: 'ready'|'barrier'|'stopped'`. Any other payload/reason combination refuses.

Pre-admission HTTP errors have exactly `{version: 1, reason}` with no identity:
400 `invalidRequest`, 406 `versionMismatch`, 401/403 `inaccessible`. They never
echo unvalidated input. Admitted receipts use HTTP 200, including refused outcomes.
Actions use `POST /api/browser/tabs/:tabId/actions` with the semantic discriminant.
`SemanticReceiptV1` has exactly `version: 1`, `requestId`, admission `identity` without
lease, `outcome: 'completed'|'rejected'|'aborted'|'uncertain'`, optional `reason` and
optional `editContinuation`. Non-completed outcomes require a reason and prohibit
continuation; completed omits reason. Closed refusal reasons are `inaccessible`,
`versionMismatch`, `invalidRequest`, `staleLease`, `staleTree`, `staleNode`, `staleFocus`,
`staleEpoch`, `navigationChanged`, `frameChanged`, `viewportChanged`, `inputReset`,
`unsupportedAction`, `secretDenied`, `queueFull`, `deadline`, `engineUnavailable`,
`resetFailed`, `dispatchFailed`, `responseLost`. Unknown/unauthorized IDs use only
`inaccessible`; finer reasons require a previously authorized binding.

`SemanticEditContinuationV1` has exactly full fresh `identity`, `frameId`,
`frameNavigationGeneration`, `nodeRef`, `focusRevision`, `expiresInMs: 1..2000`,
`eventStreamId: string`, `coveredEventSequence: SafeInt` and `allowedKinds`. The watermark identifies the last
notification sequence included in this post-edit validation; it grants no authority
to skip uncorrelated changes. Its actor/grant-bound lease permits one exact focused field:
plain-text `allowedKinds` is exactly `['insertText','replaceText','key']`; secret is
exactly `['writeSecret']`. It is returned only after a completed edit and successful
post-dispatch binding revalidation. No selector, value, selection or text is returned.
A completed dispatch does not guarantee a site's intended outcome. A new snapshot
confirms nonsecret field content; secret writes receive no value confirmation.
Page strings/AX payloads and typed values never enter durable session/room SSE,
analytics, logs, crash reports or receipts; continuation leases are excluded from audit.

Authenticate by the existing header/cookie transport and check exact origin and
CSRF/stream-upgrade policy. Short-lived tickets, if required by a stream transport,
are actor/tab/grant-bound and revocable; never put durable credentials in URLs.
Return the same inaccessible-object refusal for unknown and unauthorized IDs.
Each successful read issues a lease bound to the authenticated actor, selected
owner-qualified grant, attachment scope, tree revision and expiry. The server
retains that small binding; callers cannot transfer the lease to another actor or
scope. Shared engine node references remain non-authoritative: an action also needs
its own current lease containing that node. Grant changes are checked before serializing each outbound snapshot/notification,
not merely when the subscription opens.

Notifications carry only metadata; dirty/focus events suspend old actionable refs.
Unrelated events require a fresh snapshot; §8 defines the sole bounded own-edit exception.
Coalesce dirty notifications into one pending update per viewer only when correlation
matches; any unrelated invalidation strips correlation and takes precedence. Assign
sequence on publication, not per observed mutation; coalescing never skips sequences.
A receipt watermark covers the final published expected edit/selection events. Controller/grant/reset notices
must not wait behind extraction. Sequence gaps or an expired resume cursor require
`reset` and a new HTTP snapshot. There is no semantic-content replay after reconnect.
The client binds responses to initiating tab, browser, subscription generation and
grant revision; a late response cannot overwrite a newer tab or controller epoch.
Never order per-tab epochs across two different tabs.

A snapshot lease lasts at most two seconds and is revoked immediately on dirty state.
The server rejects rather than automatically refreshes and replays a stale action.
A stale response clears actionable controls and shows a named refresh state; it
cannot satisfy an own-edit continuation.
Loss of a subscriber leaves the Page and controller lifetime intact. Grant revocation
or authenticated actor disconnect invalidates that actor's pending work and closes
its semantic/pixel streams; input reset follows the control barrier when required.

## 5. Extraction and sanitization algorithm

The engine opens private target-scoped CDP sessions through the supported Playwright
session API. CDP Accessibility exposes computed AX properties and a DOM backend
association; its node IDs are not public application identities. Enabling AX tracking
has a performance cost. Pin and test the supported protocol revision rather than
assuming tip-of-tree behavior. [Playwright CDPSession](https://playwright.dev/docs/api/class-cdpsession),
[Chromium Accessibility protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Accessibility.pdl).

1. Recheck read authority and obtain the browser/tab/frame registry under an engine
   generation read lease. Enable AX and DOM observation for each supported target.
   Enumerate attached frame documents, including separate-process iframe targets;
   each has a fresh engine frame ID and navigation generation. If a target cannot
   be mapped safely, emit an `unsupportedFrame` node with no actionable descendants.
2. Install fixed, private-world observers for DOM structure/text/attributes and
   `focusin`, `focusout`, `input` and selection changes in each document. Combine
   them with AX updates, DOM document replacement and frame lifecycle events.
   Increment dirty/tree or focus generations synchronously when these are observed.
   These observers are invalidation hints, not proof that every shadow-DOM or AX
   mutation was observed. Never export their callbacks or arbitrary evaluation.
3. Read bounded AX roots/children in deterministic preorder using `getRootAXNode`
   and `getChildAXNodes`; use `getPartialAXTree` for exact action revalidation.
   Do not request an unbounded full DOM or dump HTML. Keep backend associations
   private. Drop ignored nodes while preserving the relative order of included
   children; retain frame boundaries as owned `frame` nodes. Resolve editable/actionable
   bindings with fixed DOM inspection functions in the private isolated world.
4. Map roles and states to the strict schema. Inspect native DOM input type,
   editability, disabled/readonly state and connection before granting action kinds.
   AX role alone cannot authorize editing, and ARIA can be false or malicious.
   Convert names/descriptions/text to valid Unicode plain text, normalize newlines,
   remove control and bidi-override characters, and bound UTF-8 bytes. Do not copy
   AX sources, related DOM attributes, descriptions containing markup, target URLs,
   image data, link destinations, browser internals or protocol errors.
5. For native password/secure fields and their value subtrees, omit value, text,
   selection, length and AX source data before hashing, serialization or retention.
   Use the owned name “Password field” and `redacted: true`; expose only focus and
   permitted write-only edit affordances. Suppress autofill/credential hints and
   file-input values. Unknown sensitive edit kinds have no value/edit capability.
   Nonsecret editor values are returned only if their entire bounded value fits;
   otherwise mark edit unsupported instead of returning a misleading editable prefix.
6. Recheck all generation counters after extraction. Discard an unstable candidate,
   retry once within the extraction deadline, then return `unavailable: unstable`.
   Issue fresh node references only for a stable candidate; record exact private
   DOM object identity, frame document, semantic fingerprint and monotonic expiry.
   A fingerprint covers sanitized role/name/state/hierarchy and native edit kind;
   confidential input values never participate in a public digest.

CDP methods can return a very wide subtree even at a shallow depth. Output limits
below do not imply a pre-allocation bound on the browser/protocol response. Extraction
runs in the separately supervised engine process, never the authenticated web server;
that process needs enforced working-memory/admission limits and an independently
verified exhaustion path. Reject oversized responses immediately, release target
sessions and report semantic unavailability. If runtime isolation cannot prevent
extraction from exhausting the app, the hostile-page acceptance gate fails; do not
claim a bounded protocol allocation from a post-parse slice.

Playwright's ARIA snapshot APIs provide structured page descriptions, including a
JSON form in 1.63. They are useful test oracles, not this public wire schema or a
stable action authority. The outline prototype's YAML and positional key navigation
must not be promoted into persistent node references. [Playwright Locator snapshot APIs](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot-json).

Redaction covers known secure controls, not every secret a site may put in ordinary
text or an accessible label elsewhere. Viewing still exposes private page content;
the owner disclosure in the production contract applies. Sanitization prevents app
origin injection, not universal confidentiality against a malicious website.

## 6. Canonical action dispatch

Every semantic operation enters the same actor-bound serialized queue as pointer,
keyboard and agent work. At admission and immediately before each unstarted step:
recheck grant/owner/attachment, browser/tab/frame lifetime, navigation, viewport,
current clean tree revision, node lease, controller epoch and input generation.
Re-resolve the exact private DOM object, verify connection/document and native edit
kind, and obtain current AX properties. Force a fresh comparison when observation
coverage is incomplete; any unexpected role/name/state/hierarchy change refuses the
operation. Never fall back to the same name, selector, index, old rectangle or a
replacement element. A read-only viewer cannot focus, select, edit or activate.

| Operation     | Engine mapping and policy                                                                                                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focus`       | Private `DOM.focus` on the exact bound backend object, inside the queue; verify the resulting active element in its document and the top-level frame focus chain. No local outline movement invokes it implicitly.                                                                                                            |
| `activate`    | Only current enabled/focusable button or link. Focus the exact object, verify it again, then send canonical `Enter` through the manager keyboard dispatcher. No `element.click()` or script handler invocation.                                                                                                               |
| `toggle`      | Only current enabled/focusable checkbox, radio or switch. Exact focus then canonical `Space`; report observed checked state after dispatch, without promising a toggle a site prevents.                                                                                                                                       |
| `insertText`  | Require the exact target already focused, writable native plain-text field, current focus revision and valid selection. Send bounded committed text through the manager text dispatcher. No setter or fabricated DOM `input`/`change` event.                                                                                  |
| `replaceText` | Same preconditions; one bounded select-all chord appropriate to the recorded engine platform, followed by text insertion. Verify selection is within the exact editor before insertion; no document-wide select-all or blur/submit.                                                                                           |
| `writeSecret` | Require exact already-focused writable native password field plus current control and explicit secret-input permission. Insert, or bounded select-all then insert, through the manager dispatcher; recheck both grants and binding before every step. Never read back/echo the prior or resulting value, length or selection. |
| `key`         | Require exact canonical focus binding. Map enum to bounded manager key down/up steps; `Tab`/`ShiftTab` follows the real Page order and can move into another supported frame. Read back actual focus; never guess its successor from AX preorder.                                                                             |

Focus and keyboard steps use private CDP/Playwright only behind the engine command
policy. DOM backend resolution and focus are supported protocol operations; their
availability does not grant callers raw protocol access. Secret fields reject
plain-text writes. Text-affecting raw keys also require the secret permission;
nonediting focus/navigation alone does not. Revocation during select-all aborts
unstarted insertion and continuation, with held input reset before the next action. [Chromium DOM protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/DOM.pdl).

A focus action may change AX focus state before its next step. Internal continuation
may rebind only that operation's expected focus/selection transition after checking
the same DOM object, grant, epoch and unchanged structural/edit fingerprint. It
cannot authorize old client references at a new revision. Any unrelated dirty DOM,
frame replacement or unexpected focus event aborts remaining steps. An edit receipt
can return a short-lived continuation only after revalidating the same exact DOM
object/focused field, unchanged actor/grant, browser/tab/frame documents, viewport,
epoch and input generation, plus a freshly published tree revision. Only expected
value/selection changes from this operation qualify; structural changes, replacement,
site-driven focus moves or unattributable mutations do not. Emit `editRequestId` only
for those qualifying dirty transitions, never for arbitrary mutations occurring
during input. Other nodes require a snapshot. Password receipts contain no text,
selection, value or length. No public identity map or stable-label inference is used.

Dynamic websites can mutate between validation and a browser-dispatched effect;
there is no browser transaction that freezes page JavaScript. Revalidate after each
step, classify completed/partial/uncertain outcomes truthfully, and stop remaining
steps on mismatch. Never retry a side effect automatically. Navigation caused by an
already dispatched activation is an observed outcome; it revokes the old tree rather
than granting authority over the destination document.

Takeover/controller disconnect first increments epoch, invalidates queued actions,
clears semantic continuation bindings, and resets held mouse/modifier/composition
state through the existing manager barrier. Reset increments `inputGeneration` and
revokes trees even if the controller actor stays the same. New controller input waits
for successful reset; the barrier is bounded to two seconds and stops further input
on failure. An already started effect cannot be undone. Abort cleanup releases any
held chord before the next queued action, using the same bounded reset path.

## 7. Invalidation, bounds and retention

| Cause                                                     | Required response                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DOM/AX change or object replacement                       | Mark tree dirty before further dispatch, revoke old node references, coalesce refresh notification. Dispatch also performs exact-node/fingerprint revalidation. |
| Main navigation, renderer replacement or browser restart  | Revoke all old tree/node/focus bindings. Mint new document or browser identity; never replay old input.                                                         |
| Child-frame navigation/detach/target swap                 | Revoke frame references and the aggregate tree revision; no fallback into main frame or new iframe.                                                             |
| Viewport resize, zoom-related canonical geometry change   | Increment viewport/tree generation, revoke old bindings and refresh. Local viewer layout changes do not resize the Page.                                        |
| Takeover/handoff, same-actor reacquisition or input reset | Increment epoch/input generation as applicable; revoke queued work and all continuation references; publish fresh state only after reset barrier.               |
| Grant expiry/revocation, owner/room membership change     | Recheck effective grant; close affected streams, discard retained content and reject pending dispatch. No room/session replay of semantic content.              |
| Stream gap, stale response, disconnect or stopped engine  | Clear actionable UI, expire local editing buffers, require fresh subscription/snapshot. Never show a new tab's focus using an old response.                     |

Initial proposed limits are part of version 1 and need measured acceptance, not a
claim that current runtime memory is safe:

| Resource             | Bound / exhaustion behavior                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public snapshot      | 256 KiB UTF-8 JSON, 2,000 nodes, 32 levels, 32 frame documents; explicit completeness/reason.                                                                                                           |
| Strings              | Name 512 bytes; description 1,024; text/value 2,048; no split surrogate or silent editable truncation.                                                                                                  |
| Extraction           | One per tab at a time, one pending refresh, 5 starts/second/tab, 1-second deadline including one retry. Budget exhaustion returns unavailable.                                                          |
| Private bindings     | At most 2,000 current refs/tab, 2-second expiry; one retained current revision plus dirty metadata. No historical DOM handles. Release private Runtime object groups on replacement/reset/lease expiry. |
| Semantic leases      | At most one current lease/subscriber, 8/tab; bind actor/grant/attachment and current node membership without duplicating DOM handles.                                                                   |
| Actions              | Existing control admission limit at most 64 pending/tab, 16 KiB request, 2,048-byte text commit, at most 16 expanded steps and 2-second execution/barrier limit.                                        |
| Subscribers          | At most 8/tab, one pending semantic notification/viewer; stalled subscribers cannot block extraction/input or other viewers.                                                                            |
| Metadata resume ring | At most 128 events/tab or 5 minutes, whichever expires first; no page strings. Gap forces reset.                                                                                                        |
| Client memory        | One current snapshot/editor buffer; no localStorage, IndexedDB, transcript persistence or automatic clipboard copying. Clear on revoke/detach; secret buffer clears after send/failure.                 |

Truncated snapshots are explicitly read-only in version 1. Do not activate nodes
from a prefix that omits modal, ownership or focus context. A user can request a
server-validated bounded subtree in a future minor contract; arbitrary root selectors
or skipping the current completeness check are not version-1 escape hatches.

## 8. Assistive focus and status behavior

Provide an owned, labeled “Remote page structure” region with a virtual browsing
cursor and explicit remote actions. Local keyboard/assistive focus stays in app
chrome until the person chooses “Focus on page” or an authorized edit/activation.
Display role, sanitized name and actual observed state without reproducing arbitrary
remote ARIA roles on app nodes. A controlled tree component implements local
navigation; its selected item is distinct from the canonical focused node.
[WAI-ARIA tree view guidance](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/).

Show controller identity/status, freshness, view-only scope and canonical focus.
Ordinary dirty revisions clear virtual selection and return it to the region heading.
Move keyboard focus only if it was inside the invalidated editor/outline; unaffected
app chrome keeps focus. Agent focus and remote alerts never steal local focus.

An owned editor permits one in-flight commit, with a two-second deadline. Suspend
all old actionable refs immediately, but preserve initiating local editor focus
while that request awaits validation. Do not send further commits or replay buffered
characters. Pending text is never displayed as confirmed remote content. A secret
editor uses a native password control, disables autofill and clears its text on send;
preserving its local focus never preserves or echoes a secret buffer.

Only a completed receipt for that exact `requestId` can resume editing. Match its
fresh continuation and stream ID to the initiating authenticated actor/attachment/grant context
and request's browser/generation, tab, frame/document, navigation, viewport, epoch
and input generation; the server lease rechecks exact grant and exact DOM field.
Require a fresh tree revision, current focus revision, allowed edit kind and unexpired
lease. Replace only this editor's refs; other outline refs remain suspended until a
snapshot. Keep local editor focus without exposing unconfirmed value or moving it
from another app control. The next character is a new explicit commit using the
fresh lease, not replay of the previous request.

If matching dirty/selection `editRequestId` arrives first, keep the editor pending with refs
suspended; adopt the receipt only when all observed dirty/selection sequences through its
`coveredEventSequence` are correlated to that request and exact initiating stream. If the receipt arrives first,
hold continuation pending until ordered events reach its watermark. Later delivery
of covered matching events cannot blur the validated editor or invalidate its fresh
refs. An uncorrelated dirty/selection event, unexpected focus event, replacement, sequence gap,
revocation/control/reset change, deadline or failed/uncertain receipt cancels this
exception, clears buffers/refs and requires explicit refresh/retargeting. Never
infer causality from timing, a label, a matching field value or request ID alone.
Expected selection changes qualify only after private per-step validation and carry
the same request correlation. Actual focus moves never qualify. The server emits at
least one correlated dirty event for the fresh edit revision; receipt watermarks use
that exact stream, so notification ordering cannot depend on a peer's delivery.

Use owned polite status for canonical focus, accepted edit, freshness and refusal;
assertive status is reserved for control loss/stopped browser. Remote live-region
properties never choose app priority. Coalesce page-change announcements once/second
and cap excerpts at 256 sanitized bytes. Password status says only “Password field”;
never announce characters, value, selection or length. Assistive echo settings remain
operator-controlled; no claim prevents an assistive tool reading personally typed text.

## 9. Required negative controls and acceptance

Contract/schema tests must reject forged actor/owner, wrong grant/attachment,
view-only focus/edit, wrong browser/tab/frame, another actor's semantic lease,
unsupported version/keys/roles, oversized text and unknown fields. Cross-owner IDs
must not reveal existence. Revocation while extraction or delivery is pending must
prevent disclosure; revocation while an action is queued must prevent dispatch.

Real fixture engine tests must prove exact target identity and actual Page effects:

- Replace a focused button/input with identical role/name/position and retain the old
  reference: no action reaches the replacement. Removing the node/document check
  must produce the specific unintended fixture mutation, not merely any assertion.
- Main/child-frame navigation, same-origin/cross-origin target swap, detach, viewport
  resize and a modal/overlay change reject retained refs. Removing each guard must
  expose its named wrong-target effect; metadata-only tests are insufficient.
- Same actor reacquires control after an epoch/input reset: old requests refuse.
  Agent-to-human identity mismatch alone cannot prove the epoch guard. Hold a chord
  or composition, cancel its release, then prove first successor input is unmodified.
- Secret-write tests revoke the secret grant between select-all and insertion: no
  unstarted write or continuation proceeds. Plain-text/raw-key bypass, wrong native
  field kind and secret echo must each fail their specific negative control.
- Password sentinel, file value, raw backend ID, URL, AX source and malicious markup
  are absent from snapshots, receipts, logs, persisted events and app DOM. Removing
  the sanitizer must reveal the named sentinel. An unrelated setup failure is unverified.
- Delayed old-tab/tree response cannot replace new focus/epoch; losing an action
  response never replays input. Removing client-generation checks must fail the
  specific retained-response assertion while later refreshes remain held.
- Complete, truncated, unstable, very wide/deep and shadow/subframe cases enforce
  read-only/budget behavior without blocking input or exhausting the web server.
  Private extraction allocation/process ceilings need actual hostile-fixture proof.
- Successive explicit character commits preserve initiating local editor focus and
  change the same canonical field using each fresh continuation. Exercise both
  dirty-before-receipt and receipt-before-dirty, holding later snapshots/events so
  they cannot hide stale-ref adoption. Peers receive no edit correlation or secret echo.
- Replacement, unrelated DOM mutation/focus, delayed old receipt, grant revocation
  and deadline clear the pending editor even when names/values match. Secret commits
  preserve focus only with exact current grant/field; buffers clear on send and no
  value/length/selection enters correlation, receipts, announcements or persistence.
- Observe canonical focus order, input/textarea edits, Space/Enter activation and
  actual remote state from two viewers; local outline focus never mutates the Page.

Production readiness requires a recorded assistive-technology matrix: VoiceOver on
supported macOS/browser and desktop surfaces; NVDA on supported Windows web browsers;
TalkBack on the supported Android web surface and VoiceOver on supported iOS web
surface. Windows desktop remains alpha until its separate real-install gate passes.
Record exact OS/browser/AT/runtime versions, fixture scope and observations for focus
order, text editing, status announcements, navigation, revocation, stale refusal,
mobile scrolling and composition. JAWS and additional combinations remain explicitly
unsupported until observed. These are proposed acceptance targets, not passed tests.
An outline, screenshot, DOM assertion or synthesized keyboard event cannot substitute
for an actual assistive-technology session.

## 10. Approval boundary

Review must approve strict schemas, grant semantics, per-frame extraction mapping,
private DOM binding/action policy, invalidation and continuation rules, retention
bounds and the supported test matrix before production decomposition is ready.
This document resolves a design proposal gap; it does not itself close contract
approval, hostile-page allocation, network policy, native input, AT or release gates.
No implementation or experiment source changes are authorized by its existence.
