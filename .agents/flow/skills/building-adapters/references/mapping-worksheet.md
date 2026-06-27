# Mapping worksheet

Fill-in tables for Step 2: turn the adopter's tracker concepts into the generic
`WorkItem` model. Copy these tables into your working notes, fill the right-hand
columns from your tracker, then transcribe the result into the generated adapter's
normalization section. Authoritative rules live in
[`.agents/flow/adapters/SPEC.md`](../../../adapters/SPEC.md) section 2.

---

## 2a. State -> `stateCategory`

List **every** workflow state your tracker defines, and map each to one of the
**five** categories. No sixth value exists.

| Your tracker's state (display name) | `stateCategory` (one of: backlog \| unstarted \| started \| completed \| canceled) |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `<state 1>`                         | `<category>`                                                                       |
| `<state 2>`                         | `<category>`                                                                       |
| ...                                 | ...                                                                                |

Rules:

- The display name becomes `stateName` (rendering only); the **category** is what
  the engine branches on. Never match on the display name.
- A **holding / un-triaged** state (an item not yet classified) maps to
  **`backlog`**: non-terminal, so it lists and recovers like any open item. It is
  kept out of dispatch by the **absent `agent/ready` label**, not by its category.
- If your tracker exposes a state's category natively (a `type` or `category`
  field), use it directly. If it only exposes display names, build this map once
  from the tracker's state list and reuse it in every read verb.

### Worked example (generic tracker "Acme")

| Acme state    | `stateCategory` |
| ------------- | --------------- |
| `Inbox`       | `backlog` †     |
| `Backlog`     | `backlog`       |
| `Selected`    | `unstarted`     |
| `In Progress` | `started`       |
| `In Review`   | `started`       |
| `Shipped`     | `completed`     |
| `Won't Do`    | `canceled`      |

† `Inbox` is Acme's un-triaged holding state; it normalizes to `backlog`, not a new
category.

---

## 2b. Native labels -> generic families

The engine matches **literal, namespaced** label strings. Map each native label to
its generic family form before placing it on `labels[]`. If your tracker stores
labels as **bare leaves** (for example `ready`) or under a tracker-specific
grouping, re-namespacing is **mandatory**: a raw leaf silently fails the engine's
match (and `INV-4`).

| Family    | Generic leaves the engine expects                                                                        | Your tracker's native label(s)   |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `agent/*` | `agent/ready`, `agent/claimed`, `agent/completed`, `agent/needs-input`                                   | `<native ready / claimed / ...>` |
| `stage/*` | `stage/capture` ... `stage/done` (the active spine-stage projection)                                     | `<native per-stage label>`       |
| `type/*`  | `type/idea`, `type/research`, `type/hypothesis`, `type/task`, `type/monitor`, `type/signal`, `type/meta` | `<native per-type label>`        |

Rules:

- `agentDisposition` is derived from the `agent/*` family:
  `agent/ready -> ready`, `agent/claimed -> claimed`, `agent/completed -> completed`,
  `agent/needs-input -> needs-input`.
- `type` is derived from the `type/*` family and is **mutually exclusive**: exactly
  one per item.
- Build the leaf-to-family map from the tracker's label list (where parent/child or
  grouped labels exist, recover the family from the parent and the leaf from the
  child). Apply it in every read verb that returns `labels[]`.

### Worked example (Acme stores grouped labels as bare leaves)

Acme surfaces a grouped label as just its leaf (`ready`, not `agent/ready`). The
adapter re-namespaces leaf -> family on the way out:

| Acme leaf on the item | Re-namespaced onto `labels[]` |
| --------------------- | ----------------------------- |
| `ready`               | `agent/ready`                 |
| `claimed`             | `agent/claimed`               |
| `verify`              | `stage/verify`                |
| `research`            | `type/research`               |

---

## 2c. Native fields (never labels)

`priority` and `size` are **native fields**, not labels. Map these plus the
remaining optionals. A missing optional is **`undefined` (neutral)**, never a
fabricated value: neutral is not "lowest" or "smallest".

| `WorkItem` field | Source on your tracker                                  | Notes                                                                                               |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `priority`       | native priority field                                   | `0` none, `1` urgent, `2` high, `3` medium, `4` low. Missing -> `undefined`, never `0`.             |
| `size`           | native estimate / points / t-shirt field                | Drives sub-issue promotion + the dispatch size tier. Missing -> `undefined`, never `0` or smallest. |
| `assignee`       | native assignee (account id)                            | Raw input to ownership classification; the adapter does not classify. Unassigned -> `undefined`.    |
| `project`        | native project -> `{ id, name, stateCategory?, lead? }` | Unset -> `undefined`. A project without a workflow category leaves `stateCategory` `undefined`.     |
| `parent`         | native parent -> the parent's `identifier`              | Top-level item -> `null`.                                                                           |
| `relations`      | the tracker's **typed** relation graph                  | As `identifier`s, never native ids. Never parse from prose. Missing graph -> neutral (no blockers). |
| `createdAt`      | native creation timestamp                               | ISO-8601. Feeds the dispatch age tier (oldest first). Missing -> `undefined`.                       |

---

## Required scalar fields (always present)

These are not optional; every `WorkItem` carries them:

- `id` - tracker-native id (opaque outside the adapter; never matched on by the
  generic layer).
- `identifier` - the human key (for example `ABC-123`); the worktree/branch key and
  the key used in every relation array. Non-empty.
- `title` - always carried so a human surface can render `identifier` then `title`
  with no extra fetch.
- `description` - the item body.
- `type` - derived from `type/*` (2b).
- `stateCategory` - from 2a.
- `stateName` - the display state name (rendering only; never matched on).
- `parent` - parent `identifier` or `null`.
- `relations` - `{ blocks[], blockedBy[], children[], relatedTo[], duplicateOf? }`,
  arrays of `identifier`s.
- `labels` - all labels, re-namespaced into the generic families (2b).
