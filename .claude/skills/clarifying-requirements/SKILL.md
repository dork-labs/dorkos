---
name: clarifying-requirements
description: Analyzes user prompts for gaps, ambiguities, and unstated assumptions, then asks clarifying questions before work begins. Use when requests are vague, lack acceptance criteria, or have hidden complexity.
---

# Clarifying Requirements

This skill teaches you to analyze user prompts for gaps, ambiguities, and unstated assumptions—then ask the questions the user failed to ask BEFORE beginning work.

## Core Principle

**Don't just answer what was asked—anticipate what SHOULD have been asked.**

Users often don't know what they don't know. Your job is to surface:

- Gaps in their thinking
- Unstated assumptions that could derail implementation
- Questions that would improve outcomes if asked upfront
- Scope ambiguities that lead to rework

## When to Apply This Skill

Activate proactive clarification when the user's request:

| Signal                     | Example                                   | Why It Matters                                |
| -------------------------- | ----------------------------------------- | --------------------------------------------- |
| Vague action verbs         | "add", "improve", "fix" without specifics | Undefined scope leads to wrong implementation |
| Missing constraints        | "make it faster" without metrics          | No way to know when you're done               |
| Complexity underestimation | "just", "simple", "quick", "easy"         | Often hides edge cases                        |
| Multiple features bundled  | "add X and Y and also Z"                  | Scope creep, unclear priority                 |
| Goal without criteria      | "users should be able to..."              | No acceptance criteria                        |
| Assumed context            | "fix the bug" (which bug?)                | Missing reproduction steps                    |

## Analysis Framework

Before beginning work, run this mental checklist:

### 1. Clarity Test

> "Can I implement this without making assumptions?"

If NO, identify what assumptions you'd have to make and ask about them.

### 2. Scope Test

> "Are boundaries explicitly defined?"

If NO, ask what's in scope and what's explicitly out of scope.

### 3. Completeness Test

> "Do I have all information needed to succeed?"

If NO, identify the missing information and ask for it.

### 4. Risk Test

> "What could go wrong that the user hasn't considered?"

Surface risks proactively—users appreciate when you catch issues early.

### 5. Alternative Test

> "Is there a better way to achieve the underlying goal?"

Sometimes the best clarification is suggesting a different approach entirely.

## Question Generation by Request Type

### For Creation Requests ("add", "create", "implement", "build")

Ask about:

- **What exactly?** Not "add a feature" but "add a login button that..."
- **Where?** Which file, component, page, layer?
- **How should it behave?** Happy path, error states, edge cases
- **What patterns to follow?** Existing conventions, components to reuse
- **What's out of scope?** Explicitly exclude to prevent creep

Example questions:

```
Before I implement this, I want to make sure I understand the scope:

1. **Location:** Should this live in the existing UserProfile component or as a new standalone component?

2. **Behavior:** What should happen if the API call fails? Show an error message, retry silently, or something else?

3. **Scope boundary:** You mentioned "user settings" - does that include notification preferences, or just profile info for now?
```

### For Debug Requests ("fix", "bug", "error", "broken", "not working")

Ask about:

- **Expected vs actual:** What should happen? What happens instead?
- **Reproduction:** Steps to trigger the issue
- **Timing:** When did this start? After a recent change?
- **Frequency:** Always, sometimes, only under certain conditions?
- **Already tried:** What debugging has been done?

Example questions:

```
To debug this effectively, I need a bit more context:

1. **Expected behavior:** What should happen when you click the submit button?

2. **Actual behavior:** What happens instead? (Error message, nothing, wrong result?)

3. **Reproduction:** Does this happen every time, or only sometimes? Any specific conditions?
```

### For Improvement Requests ("improve", "optimize", "enhance", "refactor")

Ask about:

- **Success metric:** What defines "improved"? Faster? Cleaner? More readable?
- **Baseline:** What's the current state? (measure before optimizing)
- **Constraints:** What can't change? Dependencies, APIs, behavior?
- **Trade-offs:** What's acceptable to sacrifice? (e.g., readability for performance)

Example questions:

```
To make sure I improve this in the right direction:

1. **Success metric:** When you say "faster", do you mean initial load time, interaction responsiveness, or API response time?

2. **Constraints:** Are there any parts of this code I shouldn't touch? (e.g., public API, backwards compatibility)

3. **Trade-off tolerance:** Would you accept slightly more complex code if it means 50% better performance?
```

### For Research/Understanding Requests ("how does", "explain", "what is")

Usually these don't need clarification—answer directly. But ask if:

- The topic is broad (narrow the focus)
- Multiple interpretations exist (clarify which one)
- Depth is unclear (high-level overview vs deep dive)

## Questioning Strategy

### Do: Limit to 2-4 Questions

Too many questions overwhelms. Pick the highest-impact clarifications.

### Do: Explain Why Each Question Matters

```
**Location:** Should this be a new page or a modal?
↳ This affects routing, state management, and URL structure
```

### Do: Always Recommend (Not Just Suggest)

Every question must have a recommendation. Don't just "suggest defaults" — **take a position** and explain why based on what you know about the codebase, research, and domain:

```
**Error handling:** How should we handle API failures?
↳ I recommend toast notifications with retry (our standard pattern in ChatPanel and PulsePanel).
  This keeps the UI consistent and users already understand the interaction.
```

### Do: Use AskUserQuestion for Bounded Choices

When there are clear options, use the structured question tool. **The first option MUST be your recommendation**, marked with `(Recommended)` in the label. The description should explain WHY based on evidence:

```
AskUserQuestion:
  question: "How should we handle authentication failures?"
  options:
    - label: "Silent retry with refresh token (Recommended)"
      description: "Best UX — matches the existing session refresh pattern in agent-manager.ts. Users never see transient auth failures."
    - label: "Redirect to login"
      description: "Simpler to implement but disruptive — user loses context"
    - label: "Show inline error"
      description: "Keeps user on page but adds a new error pattern not used elsewhere in the codebase"
```

### Do: Group Related Questions

Instead of 4 separate questions, group by theme:

```
**Scope clarifications:**
1. Should this include admin users or just regular users?
2. Do we need to handle the mobile app, or just web for now?

**Technical decisions:**
3. Should we use the existing form validation or Zod schemas?
```

### Don't: Ask for Information You Can Find

Search the codebase first. Don't ask "what's the database schema?" when you can read it.

### Don't: Ask Questions That Don't Change Implementation

If the answer doesn't affect what you build, don't ask.

### Don't: Repeat Questions Already Answered

Track what's been established in the conversation.

### Don't: Delay Simple Tasks

If the request is genuinely simple and clear, just do it.

### Don't: Ask Without Recommending

Never present options without a recommendation. If you've explored the codebase and done research, you have enough context to have a point of view. The only exception is when you genuinely have no basis to recommend (rare — e.g., pure aesthetic preferences with no codebase precedent).

## Recommendation Discipline

**Core principle: Asking a question without a recommendation is lazy.**

You have access to the codebase, research findings, existing patterns, and domain knowledge. Use them to form a point of view on every question you ask. The user hired you to think, not just to enumerate options.

### Why This Matters

- **Saves user cognitive load** — they evaluate your reasoning instead of starting from scratch
- **Demonstrates understanding** — your recommendation proves you've thought about the problem in context
- **Speeds decisions** — most users will accept a well-reasoned recommendation, turning a back-and-forth into a single confirmation
- **Catches bad options** — by forcing yourself to rank options, you'll notice when one is clearly wrong

### How to Form a Recommendation

Before asking any question, think through these lenses:

1. **Codebase precedent** — Is there an existing pattern? "The codebase uses X in 4 places" is strong evidence
2. **Research findings** — Did research reveal a best practice? "Industry standard is Y" carries weight
3. **Architectural fit** — Which option aligns with the project's architecture? Reference specific decisions or conventions
4. **Simplicity** — When in doubt, recommend the simpler option. Complexity needs justification
5. **Blast radius** — Prefer options that affect fewer files and introduce fewer new patterns

### Recommendation Format in AskUserQuestion

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

## Detecting Hidden Complexity

Watch for these phrases that often hide complexity:

| Phrase               | Hidden Complexity                                                  |
| -------------------- | ------------------------------------------------------------------ |
| "just add a button"  | Where? What does it do? Error states? Loading states? Permissions? |
| "simple form"        | Validation? Error messages? Submission handling? Success feedback? |
| "like the other one" | Which other one? Exactly like it or with differences?              |
| "make it work"       | What's broken? What does "working" look like?                      |
| "clean up the code"  | Refactor? Delete? Reorganize? What stays the same?                 |
| "add tests"          | Unit? Integration? E2E? What coverage? What scenarios?             |

## Integration with Existing Workflows

### With Plan Mode (EnterPlanMode)

**Plan mode has a dedicated clarification phase.** See AGENTS.md "Plan Mode Behavior" section.

When entering plan mode:

1. **Phase 1: Clarifying Questions** — Apply this skill BEFORE exploring
2. **Phase 2: Codebase Exploration** — Explore with clarified requirements
3. **Phase 3: Design & Present Plan** — Reference clarified requirements

**The key insight:** Don't explore blindly. Ask questions first, then explore with purpose.

```
❌ Wrong order:
   EnterPlanMode → Explore everything → Ask questions → Re-explore

✅ Right order:
   EnterPlanMode → Ask key questions → Explore with focus → Present plan
```

### Before `/ideate`

If a user's initial request is vague, clarify BEFORE running ideation. Ideation works better with clear inputs.

### Before `/spec:create`

Specifications require clear requirements. Ask clarifying questions to ensure the spec isn't built on assumptions.

### Before Diving Into Code

Even without formal commands, pause and ask if the request triggers any signals from this skill.

### In Regular Conversation

Not everything needs formal workflows. For casual requests that trigger complexity signals, simply ask clarifying questions inline before responding.

## Example: Full Clarification Flow

**User prompt:** "Add dark mode"

**Analysis:**

- Vague scope: "dark mode" could mean many things
- Missing constraints: Toggle? System preference? Persistent?
- No location specified: Where does the toggle live?
- No design guidance: What colors? Existing tokens?

**Response using AskUserQuestion with recommendations:**

```
AskUserQuestion:
  questions:
    - question: "How should dark mode be triggered?"
      header: "Trigger"
      options:
        - label: "System preference with manual override (Recommended)"
          description: "Best UX — respects OS setting but lets users override. This is the pattern used by most modern apps and Tailwind's dark: variant supports it natively."
        - label: "Manual toggle only"
          description: "User must explicitly switch. Simpler but ignores OS preference."
        - label: "System preference only"
          description: "No user control. Simplest but frustrating if user's OS setting doesn't match their preference for this app."

    - question: "Where should the preference be persisted?"
      header: "Persistence"
      options:
        - label: "localStorage (Recommended)"
          description: "Single-user tool — no cross-device sync needed. Matches how useTheme already stores theme state in this codebase."
        - label: "User account / database"
          description: "Persists across devices but requires backend changes and a user model."
        - label: "Session only"
          description: "Resets on refresh. Poor UX for a visual preference."

    - question: "How should dark mode colors be implemented?"
      header: "Colors"
      options:
        - label: "Tailwind dark: variant with CSS custom properties (Recommended)"
          description: "globals.css already uses CSS custom properties for colors. Adding dark: variants is the standard Tailwind v4 approach and requires no new dependencies."
        - label: "Separate dark theme file"
          description: "More isolation but harder to maintain — changes require updating two files."
```

## Balancing Act

The goal is to be helpful, not interrogative. Use judgment:

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
5. **Explain why each question matters** and why you recommend what you do
6. **Don't delay simple tasks** with unnecessary questions
7. **Surface risks and alternatives** proactively
