---
name: proactive-clarification
description: Proactively analyze user prompts, identify gaps, and ask clarifying questions before diving into work. Use when user submits vague or ambiguous requests, requests lack clear acceptance criteria, scope boundaries are undefined, or hidden complexity is detected.
---

# Proactive Clarification

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

| Signal | Example | Why It Matters |
|--------|---------|----------------|
| Vague action verbs | "add", "improve", "fix" without specifics | Undefined scope leads to wrong implementation |
| Missing constraints | "make it faster" without metrics | No way to know when you're done |
| Complexity underestimation | "just", "simple", "quick", "easy" | Often hides edge cases |
| Multiple features bundled | "add X and Y and also Z" | Scope creep, unclear priority |
| Goal without criteria | "users should be able to..." | No acceptance criteria |
| Assumed context | "fix the bug" (which bug?) | Missing reproduction steps |

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

### Do: Suggest Defaults When Reasonable
```
**Error handling:** How should we handle API failures?
↳ I'd suggest showing a toast notification with retry option (our standard pattern), unless you have a different preference.
```

### Do: Use AskUserQuestion for Bounded Choices
When there are clear options, use the structured question tool:
```
AskUserQuestion:
  question: "How should we handle authentication failures?"
  options:
    - label: "Redirect to login"
      description: "Standard approach, clears session"
    - label: "Show inline error"
      description: "Keeps user on page, can retry"
    - label: "Silent retry with refresh token"
      description: "Best UX but more complex"
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

## Detecting Hidden Complexity

Watch for these phrases that often hide complexity:

| Phrase | Hidden Complexity |
|--------|-------------------|
| "just add a button" | Where? What does it do? Error states? Loading states? Permissions? |
| "simple form" | Validation? Error messages? Submission handling? Success feedback? |
| "like the other one" | Which other one? Exactly like it or with differences? |
| "make it work" | What's broken? What does "working" look like? |
| "clean up the code" | Refactor? Delete? Reorganize? What stays the same? |
| "add tests" | Unit? Integration? E2E? What coverage? What scenarios? |

## Integration with Existing Workflows

### With Plan Mode (EnterPlanMode)

**Plan mode has a dedicated clarification phase.** See CLAUDE.md "Plan Mode Behavior" section.

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

**Response:**
```
Before I implement dark mode, I have a few questions to make sure I build the right thing:

1. **Trigger mechanism:** Should this be:
   - A manual toggle in the UI (and where should it appear?)
   - Automatic based on system preference
   - Both (system default with manual override)

2. **Persistence:** Should the preference be:
   - Saved to user account (persists across devices)
   - Saved to localStorage (this device only)
   - Session only (resets on page refresh)

3. **Existing design tokens:** I see you have color tokens in globals.css. Should I:
   - Create new dark mode variants of existing tokens
   - Use Tailwind's built-in dark: variant
   - Something else?

I can proceed with reasonable defaults (system preference + localStorage + Tailwind dark:) if you'd like to skip these questions.
```

## Balancing Act

The goal is to be helpful, not interrogative. Use judgment:

| Situation | Approach |
|-----------|----------|
| Simple, clear request | Just do it |
| Mostly clear, one ambiguity | Ask one focused question |
| Multiple ambiguities | Ask 2-3 key questions, note you'll ask more as you go |
| Fundamentally unclear | Pause and clarify before any work |
| User seems rushed | Offer to proceed with stated defaults |
| User is exploring | Match their exploratory energy, don't over-formalize |

## Summary

1. **Analyze every non-trivial request** for gaps, ambiguities, assumptions
2. **Ask the questions users didn't know to ask**
3. **Limit to 2-4 high-impact questions** per interaction
4. **Explain why each question matters**
5. **Suggest defaults** when you have reasonable guesses
6. **Don't delay simple tasks** with unnecessary questions
7. **Surface risks and alternatives** proactively
