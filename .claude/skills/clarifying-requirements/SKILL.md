---
name: clarifying-requirements
description: Analyzes user prompts for gaps, ambiguities, and unstated assumptions, then asks clarifying questions before work begins. Use when requests are vague, lack acceptance criteria, or have hidden complexity.
---

# Clarifying Requirements

Analyze user prompts for gaps, ambiguities, and unstated assumptions — then ask the questions the user failed to ask BEFORE beginning work.

## Core Principle

**Don't just answer what was asked — anticipate what SHOULD have been asked.** Users often don't know what they don't know. Surface gaps in their thinking, unstated assumptions that could derail implementation, and scope ambiguities that lead to rework. The one test that matters: "Can I implement this without making assumptions?" If not, ask about the assumptions you'd have to make.

## When to Apply

Activate proactive clarification when the request shows:

| Signal                     | Example                                          | Why It Matters                                |
| -------------------------- | ------------------------------------------------ | --------------------------------------------- |
| Vague action verbs         | "add", "improve", "fix" without specifics        | Undefined scope leads to wrong implementation |
| Missing constraints        | "make it faster" without metrics                 | No way to know when you're done               |
| Complexity underestimation | "just add a button", "simple form", "quick"      | Often hides error/loading/permission states   |
| Multiple features bundled  | "add X and Y and also Z"                         | Scope creep, unclear priority                 |
| Goal without criteria      | "users should be able to..."                     | No acceptance criteria                        |
| Assumed context            | "fix the bug" (which bug?), "like the other one" | Missing reproduction steps / referent         |

## Questioning Strategy

**Do:**

- **Limit to 2-4 questions** — pick the highest-impact clarifications
- **Explain why each question matters** ("This affects routing, state management, and URL structure")
- **Group related questions** by theme (scope vs technical decisions)
- **Use AskUserQuestion for bounded choices** — see Recommendation Discipline below

**Don't:**

- Ask for information you can find — search the codebase first
- Ask questions that don't change what you'd build
- Repeat questions already answered in the conversation
- Delay genuinely simple, clear tasks
- **Ask without recommending** — never present options without a position (rare exception: pure aesthetic preferences with no codebase precedent)

## Recommendation Discipline

**Core principle: Asking a question without a recommendation is lazy.**

You have the codebase, research findings, existing patterns, and domain knowledge. Use them to form a point of view on every question. The user hired you to think, not just to enumerate options.

Why it matters: it saves the user cognitive load (they evaluate your reasoning instead of starting from scratch), proves you've thought about the problem in context, turns a back-and-forth into a single confirmation, and forces you to notice when an option is clearly wrong.

### How to Form a Recommendation

1. **Codebase precedent** — "The codebase uses X in 4 places" is strong evidence
2. **Research findings** — a revealed best practice carries weight
3. **Architectural fit** — which option aligns with the project's conventions?
4. **Simplicity** — when in doubt, recommend the simpler option; complexity needs justification
5. **Blast radius** — prefer options that touch fewer files and introduce fewer new patterns

### AskUserQuestion Format

**The first option MUST be your recommendation**, marked `(Recommended)` in the label. Descriptions explain WHY, based on evidence:

```
AskUserQuestion:
  questions:
    - question: "Where should the new settings panel live?"
      header: "Location"
      options:
        - label: "Extend existing SettingsDialog (Recommended)"
          description: "Follows FSD patterns — SettingsDialog already handles config. Adding a tab keeps navigation consistent with the existing 3-tab layout."
        - label: "New standalone panel"
          description: "More isolation but introduces a new navigation pattern. Would need its own route and state management."
        - label: "Inline in the sidebar"
          description: "Quick access but limited space. Would need collapsible sections for complex settings."
```

### Anti-Pattern: The Option Menu

```
❌ BAD — No recommendation, no reasoning:
"How should we store this data?"
- Option A: localStorage
- Option B: Database
- Option C: File system

✅ GOOD — Clear recommendation with evidence:
"How should we store this data?"
- localStorage (Recommended) — Matches the existing theme/preference storage pattern.
  Single-user tool, no cross-device sync needed.
- Database — Overkill for user preferences. Would add a migration and schema change
  for data that's inherently client-scoped.
- File system — Only useful if the CLI needs access. Currently no CLI preference commands exist.
```

## Integration with Existing Workflows

### With Plan Mode

Plan mode has a dedicated clarification phase — apply this skill BEFORE exploring:

```
❌ Wrong order:
   EnterPlanMode → Explore everything → Ask questions → Re-explore

✅ Right order:
   EnterPlanMode → Ask key questions → Explore with focus → Present plan
```

Don't explore blindly. Ask questions first, then explore with purpose.

### Before Ideation and Specification

If a request is vague, clarify BEFORE running ideation (`/flow:ideate` when the flow plugin is loaded, or the `ideating-features` skill) — ideation works better with clear inputs. Specifications especially must not be built on assumptions.

### In Regular Conversation

Not everything needs formal workflows. For casual requests that trigger the signals above, ask clarifying questions inline before responding.

## Balancing Act

The goal is to be helpful, not interrogative:

| Situation                   | Approach                                              |
| --------------------------- | ----------------------------------------------------- |
| Simple, clear request       | Just do it                                            |
| Mostly clear, one ambiguity | Ask one focused question                              |
| Multiple ambiguities        | Ask 2-3 key questions, note you'll ask more as you go |
| Fundamentally unclear       | Pause and clarify before any work                     |
| User seems rushed           | Offer to proceed with stated defaults                 |
| User is exploring           | Match their exploratory energy, don't over-formalize  |

## Summary

1. **Analyze every non-trivial request** for gaps, ambiguities, assumptions
2. **Ask the questions users didn't know to ask**
3. **Always recommend** — every question gets a recommendation backed by evidence
4. **Limit to 2-4 high-impact questions** per interaction
5. **Don't delay simple tasks** with unnecessary questions
6. **Surface risks and alternatives** proactively
