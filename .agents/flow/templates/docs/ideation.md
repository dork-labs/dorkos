<!--
  /flow IDEATE-stage doc scaffold — `specs/<slug>/01-ideation.md`.
  Externalized from the legacy `/ideate` command so the IDEATE stage skill
  (`ideating-features`) stays thin and carries no inline template. This is the
  canonical IDEATE scaffold of the `/flow` doc-template set
  (`templates/docs/`).

  Substitute the {placeholders}; delete sections that do not apply (e.g. drop
  "Root Cause Analysis" when the work is not a bug fix). Preserve source
  fidelity — never paraphrase away concrete numbers, names, or constraints.
-->

---

slug: { slug }
number: { number }
created: { current-date }
status: ideation

---

# {Task Title}

**Slug:** {slug}
**Author:** {author}
**Date:** {current-date}

---

## 1) Intent & Assumptions

- **Task brief:** {task description}
- **Assumptions:** {bulleted list}
- **Out of scope:** {bulleted list}

## 2) Pre-reading Log

{Files/docs read with takeaways}

- `path/to/file`: takeaway...

## 3) Codebase Map

- **Primary components/modules:** {paths + roles}
- **Shared dependencies:** {theme/hooks/utils/stores}
- **Data flow:** {source → transform → render}
- **Feature flags/config:** {flags, env, owners}
- **Potential blast radius:** {areas impacted}

## 4) Root Cause Analysis

{Bug fixes only — omit this section otherwise}

- **Repro steps:** {numbered list}
- **Observed vs Expected:** {concise description}
- **Evidence:** {code refs, logs, CSS/DOM snapshots}
- **Root-cause hypotheses:** {bulleted with confidence}
- **Decision:** {selected hypothesis + rationale}

## 5) Research

- **Potential solutions:** {numbered list with pros and cons}
- **Recommendation:** {concise description}

## 6) Decisions

{Resolved decisions from clarification — not open questions.}

| #   | Decision           | Choice          | Rationale |
| --- | ------------------ | --------------- | --------- |
| 1   | {What was decided} | {User's choice} | {Why}     |
| 2   | {What was decided} | {User's choice} | {Why}     |

{If no clarification was needed, state: "No ambiguities identified — task brief and findings were sufficiently clear."}
