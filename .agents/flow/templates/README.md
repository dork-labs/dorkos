# `/flow` templates

The templates the `/flow` engine owns. They are **loaded by skills**, not
projected to any harness — a stage skill reads the scaffold it needs and
produces that shape (spec §14). Every template is **PM-agnostic**: it names
stages and the generic `WorkItem` model, never a tracker API or a
tracker-specific state name. The `linear-adapter` skill projects records onto the
configured tracker.

## `records/` — tracker work-item bodies, by type

The body a stage writes into a tracker work item. Each carries the canonical
`## Validation criteria` and `## On Completion` sections — the engine reads them
(DONE routing in `closing-work`, project-pulse continuity). Generalized from the
legacy `linear-loop/templates/` (triage-_, plan-_, dispatch-priority, audit) and
de-Linear-ified.

| Type         | File                                               | Written by (stage)                 |
| ------------ | -------------------------------------------------- | ---------------------------------- |
| `idea`       | [`records/idea.md`](./records/idea.md)             | CAPTURE / TRIAGE                   |
| `research`   | [`records/research.md`](./records/research.md)     | TRIAGE / IDEATE                    |
| `hypothesis` | [`records/hypothesis.md`](./records/hypothesis.md) | TRIAGE / IDEATE / SPECIFY          |
| `task`       | [`records/task.md`](./records/task.md)             | DECOMPOSE (promoted sub-item only) |
| `project`    | [`records/project.md`](./records/project.md)       | TRIAGE / SPECIFY (large-spec home) |

> Most tasks stay **checklist lines** mirrored from `03-tasks.json` and are never
> promoted to their own work item — promotion is the rare exception
> (`size ≥ subIssueThreshold`, default `"xl"`, spec §8). Use `records/task.md`
> only for a promoted sub-item.

## `docs/` — filesystem doc scaffolds

The canonical artifacts the intent/build stages produce on the filesystem
(filesystem is canonical; the tracker holds pointers + state, never a second copy
of the prose). Externalized from the legacy inline command templates.

| File                                               | Stage     | Artifact                           |
| -------------------------------------------------- | --------- | ---------------------------------- |
| [`docs/ideation.md`](./docs/ideation.md)           | IDEATE    | `specs/<slug>/01-ideation.md`      |
| [`docs/specification.md`](./docs/specification.md) | SPECIFY   | `specs/<slug>/02-specification.md` |
| [`docs/tasks.json`](./docs/tasks.json)             | DECOMPOSE | `specs/<slug>/03-tasks.json`       |
| [`docs/adr.md`](./docs/adr.md)                     | SPECIFY   | `decisions/NNNN-<slug>.md`         |

## `pr.md` — the review-gate PR template

[`pr.md`](./pr.md) is what the **VERIFY** stage fills when it opens/updates the
PR at the always-on human-review gate: linked work item, test/validation summary,
and the proof-of-completion evidence bundle (spec §5, §13).
