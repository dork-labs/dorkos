---
status: current
topic: What an API-refusal-caused abort actually looks like on the claude-code SDK surface
informs: apps/server/src/services/runtimes/claude-code/sdk/sdk-error-mapping.ts
---

# Aborted refusals on the claude-code SDK surface (2026-09-03)

Read for DOR-1684, which asked whether the settlement rule DorkOS ships for an
abort nobody asked for matches what the CLI actually sends. Every claim below
was extracted from the **shipped binary**, not from docs and not from the
`.d.ts` alone: `@anthropic-ai/claude-agent-sdk` **0.3.224**, whose
`package.json` pins `claudeCodeVersion: 2.1.224`. The binary is the
platform-optional dependency:

```
node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.224/
  node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
```

Recipe (the whole report is reproducible from it): `strings -a <that binary> >
/tmp/claude.txt`, then grep the minified bundle lines it contains. Re-run it on
the next SDK bump — the identifiers are minified and WILL change, but the string
literals and the predicate bodies survive.

## 1. The abort reason is computed from one signal check, for all nine causes

The CLI's own abort predicate, verbatim:

```js
function YSt(e) {
  return e === 'aborted_streaming' || e === 'aborted_tools';
}
```

That is byte-for-byte the shape half of `INTERRUPTED_TERMINAL_REASONS`
(`packages/shared/src/schemas.ts`) minus `'interrupted'`, which is DorkOS's own
synthetic reason for a stop that killed the process before the CLI could name
one. Nothing in the SDK emits `'interrupted'`.

The main loop returns those two reasons from a bare `signal.aborted` test:

```js
if(!ko&&q.abortController.signal.aborted){
  if(!DOe(q.abortController.signal.reason)) yield Xue({…});
  return V6e(q,a),{reason:"aborted_streaming"}
}
```

The CAUSE lives only in `signal.reason`, and the CLI maps the causes to its own
internal vocabulary in a function whose output never reaches the SDK surface:

```js
function Ppr(e) {
  switch (Nb(e)) {
    case 'user-cancel':
      return 'user_cancel';
    case 'remote-cancel':
      return 'remote_cancel';
    case 'shutdown':
      return 'shutdown';
    case 'interrupt':
      return 'interrupt';
    case 'background':
      return 'background';
    case 'recovery-timeout':
      return 'recovery_timeout';
    case kbo:
      return 'server_fallback_tombstone';
    default:
      return 'turn_teardown';
  }
}
```

All nine cause strings are present in the binary as literals (`user-cancel`,
`remote-cancel`, `shutdown`, `interrupt`, `background`, `recovery-timeout`,
`server_fallback_tombstone`, `turn_teardown`, `refusal-fallback-edit`).
`refusal-fallback-edit` falls into `Ppr`'s `default` bucket, i.e. it is reported
internally as `turn_teardown`, and `turn_teardown` is one of the causes the
CLI's own `wgs()` classifier answers `false` for — its "was this a person?"
question. So even the CLI does not think a refusal abort is a user cancel; it
simply has no way to say so on the wire.

**Conclusion:** `terminal_reason` answers shape and cannot answer intent. Any
DorkOS reader that needs "a person stopped this" must AND it with DorkOS's own
stop record. This is exactly what `isStoppedTurnResult` and
`isUnrequestedAbortFailure` do.

## 2. A refusal abort and DorkOS's own interrupt are indistinguishable by design

The suppression set that decides whether the CLI writes its "interrupted by
user" transcript entry has exactly two members:

```js
$E_ = new Set(['interrupt', 'refusal-fallback-edit']);
function DOe(e) {
  return $E_.has(Nb(e));
}
```

`interrupt` is DorkOS's own `query.interrupt()`. `refusal-fallback-edit` is
raised when the refusal-fallback flow resolves to `edit_prompt`:

```js
if (gu === 'edit_prompt') q.abortController.abort(KR('refusal-fallback-edit'));
```

Both therefore produce the same reason, the same suppression, and no
distinguishing field. That is the provable case DOR-1320's review named, and it
still holds on 0.3.224.

One caveat worth recording, because it narrows how often this fires **today**:
`edit_prompt` comes from a `requestDialog` whose kind is
`refusal_fallback_prompt`, and `sdk.d.ts` states the CLI "treats ABSENCE as
'cannot display' and fails closed" — a consumer that does not declare the kind
in `supportedDialogKinds` gets the classic refusal error instead of the dialog.
DorkOS declares no dialog kinds at all (no `supportedDialogKinds`, no
`onUserDialog` anywhere in `apps/server/src`), so the `edit_prompt` branch is
not reachable from DorkOS on this version. The reasoning does not depend on it:
`turn_teardown` — the unlabelled default bucket every unnamed internal abort
lands in — is reachable, carries no intent either, and is the same hole.

## 3. The result shape an abort closes with, and when it carries a fatal frame

The abort's `result` is composed here (minified, reflowed):

```js
Pt = it!==null ? [it]
   : YSt(ar) && Wr===undefined && !uKo(Jt,be)
     ? [`[ede_diagnostic] turn aborted (${ar}) stop_reason=${be}`]
     : null
…
variant:{subtype:"error_during_execution", errors:[…]}
```

with `ar` = the terminal reason, `be` = the API `stop_reason`, and

```js
function uKo(e,t=null){ if(!e)return!1;
  if(e.type==="assistant"){let r=dK(e.message.content);
    return r?.type==="text"||r?.type==="thinking"||r?.type==="redacted_thinking"} … }
```

So `uKo` asks "did the turn's last message carry assistant content?", and the
branch it guards decides whether the abort reports a failure at all:

| Abort produced…      | `result.subtype`                           | `errors`                                                                | DorkOS `lastError`                           |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------- |
| no assistant content | `error_during_execution`, `is_error: true` | `[ede_diagnostic] turn aborted (aborted_streaming) stop_reason=refusal` | a fatal frame, code `error_during_execution` |
| assistant content    | `success`                                  | —                                                                       | none                                         |

Both rows matter to settlement, and both are pinned by
`apps/server/src/services/runtimes/claude-code/__tests__/refusal-abort-settlement.test.ts`:

- **Row 1** is the DOR-1684 case. The turn has an explanation, nobody asked for
  the abort, and it must settle as a failure keeping that explanation.
- **Row 2** must NOT settle as a failure. There is no error frame, so there is
  nothing to explain; a turn cut short after it had already spoken is
  `interrupted`, and promoting it would be the mirror-image lie. This is why
  `isUnrequestedAbortFailure` requires a fatal frame as well as a negative stop
  record — the AND is not belt-and-braces, it is load-bearing on this row.

## 4. There is a structured refusal channel DorkOS does not read

`sdk.d.ts` declares two system messages for refusals:
`SDKModelRefusalFallbackMessage` (`subtype: 'model_refusal_fallback'`, emitted
when the turn was retried once on a fallback model) and
`SDKModelRefusalNoFallbackMessage` (`subtype: 'model_refusal_no_fallback'`, when
no retry ran). Both carry `api_refusal_category`, `api_refusal_explanation`,
`original_model` and `refused_user_message_uuid`. `SDKAssistantMessageError`
contains no `refusal` member — a refusal surfaces as `message.stop_reason ===
'refusal'` plus these system events.

DorkOS handles neither subtype today (nothing in `apps/server/src` mentions
them), so a refusal reaches the operator as whatever generic text the
`error_during_execution` frame carried. That is honest but not specific — the
diagnostic line above is CLI-internal prose, not a sentence written for a
person. **Not in DOR-1684's scope** (its question was who the turn blames, not
how well the blame reads), and deliberately left as a separate opportunity:
naming the refusal category and offering edit-and-retry from
`refused_user_message_uuid` would be a real UX improvement on top of the
settlement fix.
