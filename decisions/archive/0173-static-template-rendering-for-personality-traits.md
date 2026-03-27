---
number: 173
title: Static Template Rendering for Personality Traits
status: proposed
created: 2026-03-22
spec: agent-personality-convention-files
superseded-by: null
---

# 173. Static Template Rendering for Personality Traits

## Status

Proposed

## Context

Personality trait sliders (5 traits × 5 levels) need to be rendered into natural language directives for system prompt injection. Three approaches were evaluated:

1. **LLM-based rendering** — Call Claude API to generate directives from trait scores
2. **Static template lookup** — Pre-written lookup table with 25 directives per trait
3. **Hybrid** — Template lookup with LLM fallback for custom traits

The trait system must support both preview (showing what the agent will receive) and runtime injection (embedding directives in system prompts).

## Decision

Use a **static template lookup table** with 25 pre-written directives per trait (5 traits × 5 intensity levels). No LLM calls. Deterministic output. Preview always shows exactly what agent receives.

### Implementation

For each trait (e.g., "creativity", "caution", "collaboration"):

- Level 1 (minimal) → Directive emphasizing low trait intensity
- Level 2 (low) → Moderate reduction
- Level 3 (balanced) → Neutral baseline
- Level 4 (high) → Moderate emphasis
- Level 5 (maximum) → Strong emphasis

Example format:

```
"creativity": {
  1: "Prioritize literal accuracy and established patterns. Avoid speculation.",
  2: "Generally follow existing patterns. Creative solutions are secondary.",
  3: "Balance established patterns with novel approaches.",
  4: "Favor creative problem-solving while ensuring correctness.",
  5: "Prioritize novel, inventive approaches to problems."
}
```

## Consequences

### Positive

- **Deterministic** — Output never varies; preview matches runtime behavior exactly
- **Fast** — Lookup is O(1), <0.1ms per trait
- **No API costs** — Zero external service calls
- **Preview accuracy** — UI preview is guaranteed to be accurate
- **Offline capable** — Works without network access
- **Testable** — All combinations are pre-determined and verifiable
- **Clear responsibility** — Writers (not LLM) own directive quality

### Negative

- **Less nuanced** — Pre-written prose is less adaptive than LLM generation
- **Manual maintenance** — Adding new traits requires writing 5 directives by hand
- **Translation burden** — Same 125 directives must be authored in every supported language
- **Trait interdependencies** — Cannot express subtle interactions between traits
- **Fixed granularity** — Must use 5 levels; finer gradations would require exponential directive growth
