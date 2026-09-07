# Reference implementations (non-normative)

Two orchestration scripts from the September 2026 UI/UX audit programme, kept as known-good
examples of the shapes `../../SKILL.md` describes in prose.

| File             | Shape                                                              | Maps to            |
| ---------------- | ------------------------------------------------------------------ | ------------------ |
| `ui-ux-audit.js` | twelve parallel lens auditors → one synthesizer                    | SKILL.md §2 and §4 |
| `uiux-wave.js`   | per batch: worktree implementer → adversarial reviewer → finalizer | SKILL.md §7        |

**They are color, not contract.** They are written for one specific session orchestrator (the
Workflow runner and its `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()` primitives) and
they hard-code that session's absolute paths, ports, models, and tracker ids. Nothing here runs
unchanged anywhere else.

The normative procedure is the prose in `../../SKILL.md` plus the charter at `audits/ui.md`.
Where a script and that prose disagree, the prose wins, and the script is the thing that is out
of date.

They also stay **in-repo only**. If this skill is ever packaged for the marketplace, these two
files do not travel: prose procedures are the portable artifact, and a script bound to one
harness's orchestrator is the opposite of that.

One line in each file was adjusted from the original: the reminder about retired vocabulary now
points at `scripts/check-banned-words.sh` rather than naming the words it retired. Everything
else is verbatim.
