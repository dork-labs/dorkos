<!--
  /flow SPECIFY-stage doc scaffold — `specs/<slug>/02-specification.md`.
  Externalized from the legacy `/spec:create` command so the SPECIFY stage
  skill (`specifying-work`) stays thin and carries no inline template. Task 4.x
  owns the full template set; this file is the canonical SPECIFY scaffold.

  Fill every section meaningfully — a reader should be able to build the work
  from this document alone. Do NOT include time or effort estimates. Carry all
  ideation research forward; never paraphrase away precision.
-->

---

slug: { slug }
number: { number }
created: { current-date }
status: specified

---

# {Title}

**Status:** Draft <!-- Draft | Under Review | Approved | Implemented -->
**Author:** {author}
**Date:** {current-date}

## Overview

{Brief description and purpose.}

## Background / Problem Statement

{Why this is needed / what problem it solves — specific and measurable.}

## Goals

- {What we aim to achieve}

## Non-Goals

- {What is explicitly out of scope}

## Technical Dependencies

- {External libraries/frameworks + version requirements + doc links}

## Detailed Design

- **Architecture changes:** {…}
- **Implementation approach:** {…}
- **Code structure & file organization:** {paths}
- **API changes:** {if any}
- **Data model changes:** {if any}
- **Integration with external libraries:** {examples}

## User Experience

{How users interact with this — entry points, step-by-step flow, error and exit paths.}

## Testing Strategy

- **Unit tests:** {…}
- **Integration tests:** {…}
- **E2E tests:** {if needed}
- **Mocking strategy:** {for external dependencies}

Each test carries a purpose comment; avoid tests that always pass; include
edge cases that can fail and reveal real issues.

## Performance Considerations

{Impact and mitigations.}

## Security Considerations

{Implications and safeguards.}

## Documentation

{What docs need creating/updating.}

## Implementation Phases

- **Phase 1 — MVP/core:** {…}
- **Phase 2 — enhancements:** {if applicable}
- **Phase 3 — polish:** {if applicable}

## Open Questions

{Unresolved questions or decisions. Resolved ones move to a struck-through
"(RESOLVED)" entry carrying the Answer + Rationale.}

## Related ADRs

{ADRs from `decisions/` relevant to this work.}

## References

{Issues, PRs, docs, external library links, design patterns.}
