---
number: 249
title: Instant-Advance Wizard for Agent Creation
status: draft
created: 2026-04-11
spec: create-agent-two-step-flow
superseded-by: null
---

# 249. Instant-Advance Wizard for Agent Creation

## Status

Draft (auto-extracted from spec: create-agent-two-step-flow)

## Context

The Create Agent dialog was initially built as a three-tab layout (New Agent, From Template, Import) using Radix Tabs. After hands-on usage, the tab pattern introduced a DRY violation (170+ lines of duplicated Name/Directory form fields across tabs) and required users to mentally map tabs to creation paths. The Radix Tabs semantic model (parallel content panels) conflicts with the sequential intent of agent creation (choose method, then configure).

## Decision

Replace the Radix Tabs layout with an instant-advance wizard using a step state machine. Clicking a method card on Step 1 immediately transitions to the next step — no "Next" button. Step transitions use AnimatePresence + motion.div opacity fade, matching the existing AdapterSetupWizard pattern. The configure step (name + directory) is shared across blank and template paths, eliminating the form duplication. A formal StepIndicator is omitted — for 2-3 steps, the DialogDescription text change and Back button provide sufficient orientation.

## Consequences

### Positive

- Eliminates 170+ lines of duplicated form JSX
- Fastest possible path to creation — one click advances
- Matches existing wizard pattern in codebase (AdapterSetupWizard)
- Correct WCAG semantics (step navigation vs parallel tabs)

### Negative

- All existing tab-related tests require rewriting
- Template path has 3 micro-steps (choose → pick template → configure) instead of strict 2
- Store type rename from CreationTab to CreationMode (backward-compatible alias needed)
