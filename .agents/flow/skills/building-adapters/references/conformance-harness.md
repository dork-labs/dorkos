# Conformance harness (`validate-adapter.mjs`)

Step 4 in detail: the harness interface, how to build a fixture, the verify loop,
and per-invariant troubleshooting. The invariants themselves are normative in
[`.agents/flow/adapters/SPEC.md`](../../../adapters/SPEC.md) section 4; this file is
the operational guide to passing them.

---

## Interface

```bash
node scripts/validate-adapter.mjs --fixture <path-to-fixture.json>
```

- **In:** `--fixture <path>` points at a JSON file of the normalized `WorkItem`s
  your adapter's read verbs return (see [Fixtures](#fixtures)). JSON in.
- **Out:** a JSON **verdict** on stdout:

  ```jsonc
  {
    "ok": true, // false when any invariant failed
    "failures": [
      // empty when ok
      { "invariant": "INV-4", "detail": "human-readable explanation of the breach" },
    ],
  }
  ```

  - `ok: boolean` - the overall pass/fail.
  - `failures: Array<{ invariant: string, detail: string }>` - one entry per
    breached invariant. `invariant` is the id (`INV-1 .. INV-5`); `detail` explains
    what tripped and, usually, which item.

- **Exit code:** `0` when `ok` is `true` (pass); **nonzero** when any invariant
  failed (fail). Gate scripts and CI branch on the exit code; humans read the
  `failures` array.

The verdict shape (`{ ok, failures: [{ invariant, detail }] }`) and the exit-code
contract are stable; build your loop around them.

---

## Fixtures

A fixture is a JSON file holding the normalized `WorkItem`s your read verbs
produce. Make it **representative**: the harness can only check invariants against
the cases your fixture contains, so a thin fixture yields a falsely-green verdict.
Cover, at minimum:

- **All five state categories** - at least one item each of `backlog`,
  `unstarted`, `started`, `completed`, `canceled`, **plus** an item from your
  tracker's holding/un-triaged state (it must normalize to `backlog`). Exercises
  `INV-1`.
- **Readiness, both ways** - at least one item carrying `agent/ready` and at least
  one dispatchable item that lacks it (the candidate-set requirement). Exercises
  `INV-5`.
- **Relations, both ways** - an item whose `blockedBy` references another item
  **in the fixture**, and one whose `blockedBy` references a closed/out-of-set item
  (which must be treated as non-blocking). Exercises `INV-3`.
- **Labels across families** - items carrying `agent/*`, `stage/*`, and `type/*`
  in their re-namespaced form. Exercises `INV-4`.
- **Optionals present and absent** - some items with `priority`/`size`/`project`/
  `createdAt`, some without (absent, not fabricated). Exercises `INV-2`.

Generate the fixture by running your adapter's read verbs against a real (or
recorded) tracker and serializing the normalized output, so you are validating the
adapter's **actual** normalization, not a hand-written ideal.

### Negative cases (prove the harness bites)

Before trusting a green verdict, confirm the harness _can_ fail by feeding it
deliberately-broken items in a throwaway fixture - each should produce the named
failure:

- A bare-leaf label (`ready` instead of `agent/ready`) -> `INV-4` (and the
  readiness leaf also trips `INV-5`).
- A fabricated `priority: 0` for an item with no native priority -> `INV-2`.
- A `blockedBy` entry holding a native id instead of an `identifier` -> `INV-3`.
- A made-up sixth `stateCategory` -> `INV-1`.

If these do **not** fail, your fixture or invocation is wrong; fix that before
trusting any pass.

---

## The verify loop

```
build/refresh fixture
   │
   ▼
run: node scripts/validate-adapter.mjs --fixture <fixture.json>
   │
   ├─ exit 0 / ok:true  ──────────────▶  DONE (adapter conforms)
   │
   └─ exit nonzero / ok:false
         │  read failures[].invariant + detail
         ▼
      fix the MAPPING that produced the breach (not the fixture)
         │
         └──────────── re-run ──────────────┘
```

Fix the **adapter's mapping**, not the fixture, when an invariant fails: the
fixture is the adapter's output, so editing it to pass hides a real conformance
bug. The only legitimate fixture edits are to _broaden coverage_ (add a case the
fixture was missing). The adapter is not done until the verdict is `ok: true` with
exit `0`.

---

## Per-invariant troubleshooting

### `INV-1` - all five state categories are representable

- **Asserts.** Every emitted `stateCategory` is one of `backlog | unstarted |
started | completed | canceled`; states of each native category map to one of the
  five; a holding/un-triaged native state maps to `backlog`; no sixth category is
  ever emitted.
- **Usual cause.** A tracker-native category leaked through (you passed the
  tracker's own `type` string), or a holding state was given a new bucket.
- **Fix.** Revisit the 2a table. Map every state to exactly one of the five; send
  the holding state to `backlog`. Never emit a tracker-specific value.

### `INV-2` - required fields present and correctly typed

- **Asserts.** Every `WorkItem` carries the required fields with correct types
  (`id`, `identifier` non-empty strings; `title`, `description`, `stateName`
  strings; `type` one of the seven; `stateCategory` one of the five; `parent`
  `string | null`; `relations` with `string[]` arrays; `labels` `string[]`).
  Optionals (`priority`, `size`, `project`, `assignee`, `agentDisposition`,
  `createdAt`) are absent or correctly typed. A missing optional is `undefined`,
  never fabricated.
- **Usual cause.** Defaulting a missing `priority` or `size` to `0`/smallest, or a
  missing `parent` to `""` instead of `null`, or dropping a required field.
- **Fix.** Emit `undefined` for missing optionals (neutral is not "lowest"); set
  `parent` to `null` for top-level items; ensure every required field is populated
  and typed.

### `INV-3` - relation references resolve

- **Asserts.** Every id in `relations.blockedBy` (and `blocks`, `children`,
  `relatedTo`, `duplicateOf`) is in the human-key `identifier` form, never a
  native id. Within one `getEligibleWork()`/`getProjectWork()` response, each
  `blockedBy` reference to a still-open item resolves to a member of the returned
  set; a reference absent from the set is closed/out-of-scope and treated as
  non-blocking.
- **Usual cause.** Emitting native node ids in relation arrays, or parsing
  relations from description prose, or treating an out-of-set reference as a hard
  block.
- **Fix.** Map relation endpoints to their `identifier`s. Read only the typed
  relation graph, never prose. Treat an out-of-set/closed reference as neutral
  (non-blocking).

### `INV-4` - labels are re-namespaced into the generic families

- **Asserts.** `labels[]` contains generic-family labels, not raw native leaves or
  tracker-specific groupings. `agentDisposition` is consistent with an `agent/*`
  label; the stage projection appears as a `stage/*` label; `type` matches a
  `type/*` label.
- **Usual cause.** Passing the tracker's flattened leaf labels straight through
  (`ready` instead of `agent/ready`), the single most common adapter bug.
- **Fix.** Apply the 2b leaf-to-family map in every read verb. Confirm
  `agentDisposition`, the stage label, and `type` all trace to a namespaced label.

### `INV-5` - the readiness gate is the `agent/ready` label

- **Asserts.** (a) Every item the eligibility pass admits carries the literal,
  re-namespaced `agent/ready` label; and (b) the readiness signal never appears as
  a bare leaf. `getEligibleWork()`/`getProjectWork()` return the full **candidate**
  set (items with `agent/ready` **plus** dispatchable items that lack it), so the
  loop can distinguish done from starved.
- **Usual cause.** Either expressing readiness as a bare leaf/separate field, or
  pre-filtering the candidate read down to only `agent/ready` items.
- **Fix.** Express readiness only as the `agent/ready` label (re-namespaced). Do
  **not** pre-filter: return the full candidate set and let the engine's
  eligibility pass apply the gate. Pre-filtering passes a naive check but breaks
  starvation detection ("ready: 0 but shapeable work waits").

---

## Versioning

Your adapter declares the contract version it targets (`CONTRACT_VERSION` constant
or a manifest field; SPEC section 5). The harness checks that declaration against
the contract's current version. On a contract bump, re-run the harness: a MAJOR
bump may require regenerating the adapter; a MINOR bump is additive but worth
re-validating; a PATCH bump is wording only. Pin the version you generated against
so drift is caught at validation time, not at runtime.
