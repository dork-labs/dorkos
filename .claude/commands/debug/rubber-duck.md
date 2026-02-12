---
description: Structured problem articulation using rubber duck debugging methodology to systematically work through complex bugs
argument-hint: "[brief-problem-description]"
allowed-tools: Read, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__context7__resolve-library-id, mcp__context7__get-library-docs
---

# Rubber Duck Debugging

A structured approach to debugging using the classic "rubber duck" methodology, enhanced with AI capabilities. This command guides you through articulating your problem step-by-step, which often reveals the solution.

## What is Rubber Duck Debugging?

From "The Pragmatic Programmer": The act of explaining your code line-by-line to an inanimate object (like a rubber duck) forces you to think through your logic and often reveals bugs. Research shows this "self-debugging" approach significantly improves bug detection.

**This command formalizes that methodology with:**
1. Structured problem articulation
2. Step-by-step code explanation
3. Comparison against expected behavior
4. Chain-of-thought reasoning

## Arguments

Parse `$ARGUMENTS`:
- If argument provided, use as initial problem context
- If empty, begin the structured interview

## Phase 1: Problem Articulation

### 1.1 What Are You Trying to Do?

```
AskUserQuestion:
  question: "In plain language, what is the code supposed to do?"
  header: "Expected Behavior"
  options:
    - label: "Process/transform data"
      description: "Take input, produce expected output"
    - label: "Handle user interaction"
      description: "Respond to user action (click, form, etc.)"
    - label: "Fetch/save data"
      description: "Get data from or save to database/API"
    - label: "Render UI"
      description: "Display specific content or component"
    - label: "Let me explain"
      description: "I'll describe in detail"
```

**Follow-up**: Ask the user to describe in their own words what the code should accomplish.

### 1.2 What Is Actually Happening?

```
AskUserQuestion:
  question: "What is the actual behavior you're observing?"
  header: "Actual Behavior"
  options:
    - label: "Wrong output"
      description: "Code runs but produces incorrect results"
    - label: "Error/exception"
      description: "Code throws an error"
    - label: "Nothing happens"
      description: "Code seems to do nothing"
    - label: "Partial success"
      description: "Some things work, others don't"
    - label: "Inconsistent"
      description: "Works sometimes, fails other times"
```

### 1.3 What Have You Already Tried?

```
AskUserQuestion:
  question: "What debugging steps have you already taken?"
  header: "Prior Attempts"
  multiSelect: true
  options:
    - label: "Added console.log"
      description: "Logged values to see what's happening"
    - label: "Checked error messages"
      description: "Read and tried to understand errors"
    - label: "Searched online"
      description: "Googled the error or problem"
    - label: "Tried different input"
      description: "Tested with various data"
    - label: "Nothing yet"
      description: "This is my first debugging attempt"
```

### 1.4 When Did It Start?

```
AskUserQuestion:
  question: "When did you first notice this problem?"
  header: "Timeline"
  options:
    - label: "Just wrote this code"
      description: "New code that never worked"
    - label: "After recent changes"
      description: "Was working, now broken"
    - label: "After updating dependencies"
      description: "Broke after npm/pnpm update"
    - label: "Intermittent"
      description: "Sometimes works, sometimes doesn't"
    - label: "Unknown"
      description: "Not sure when it started"
```

## Phase 2: Locate the Code

### 2.1 Identify the Files

```
AskUserQuestion:
  question: "Do you know which file(s) contain the problematic code?"
  header: "Code Location"
  options:
    - label: "Yes, specific file(s)"
      description: "I'll tell you the file path(s)"
    - label: "General area"
      description: "I know the feature/component but not exact file"
    - label: "No idea"
      description: "Help me find where the issue is"
```

### 2.2 Find the Code

If user knows the file, read it:
```
Read the file at the specified path.
Focus on the relevant function or section.
```

If user doesn't know, search:
```bash
# Search for relevant patterns
rg "[feature-name]" src/ --type ts -l
rg "[function-name]" src/ --type ts -l
```

## Phase 3: Line-by-Line Explanation

### 3.1 The Core Exercise

**This is the most important part of rubber duck debugging.**

Ask the user to explain the code:

```
AskUserQuestion:
  question: "Let's walk through the code together. Can you explain what each part does?"
  header: "Code Walkthrough"
  options:
    - label: "Yes, let me explain"
      description: "I'll describe what I think each part does"
    - label: "You explain first"
      description: "Please walk me through it, then I'll add context"
    - label: "I'm not sure"
      description: "I don't fully understand the code"
```

### 3.2 Explain the Code

Read the relevant code section and explain it line-by-line:

**For each logical block:**
1. What is the input/state at this point?
2. What operation is being performed?
3. What is the expected result?
4. What could go wrong here?

### 3.3 Identify Assumptions

```
AskUserQuestion:
  question: "What assumptions is this code making?"
  header: "Assumptions"
  multiSelect: true
  options:
    - label: "Input is valid/present"
      description: "Assumes data exists and is correct format"
    - label: "Async completes successfully"
      description: "Assumes promises resolve, not reject"
    - label: "External service available"
      description: "Assumes API/database is reachable"
    - label: "State is correct"
      description: "Assumes app state matches expectations"
    - label: "Not sure"
      description: "Help me identify assumptions"
```

## Phase 4: Hypothesis Formation

### 4.1 Generate Hypotheses

Based on the walkthrough, generate possible causes:

**Common Bug Categories:**
1. **Data issues**: Wrong type, missing field, null/undefined
2. **Logic issues**: Wrong condition, off-by-one, missing case
3. **Timing issues**: Race condition, wrong order, async problems
4. **State issues**: Stale data, wrong initialization
5. **Integration issues**: API contract, data shape mismatch

### 4.2 Rank Hypotheses

```
AskUserQuestion:
  question: "Based on our walkthrough, which seems most likely?"
  header: "Most Likely Cause"
  options:
    - label: "Data problem"
      description: "Wrong data type, missing value, bad format"
    - label: "Logic problem"
      description: "Conditional logic, calculation, or flow issue"
    - label: "Async/timing problem"
      description: "Race condition, missing await, wrong order"
    - label: "State problem"
      description: "Component/app state not as expected"
    - label: "Still unsure"
      description: "Need to investigate further"
```

## Phase 5: Systematic Investigation

### 5.1 Test Hypothesis

For the most likely hypothesis, design a test:

```
AskUserQuestion:
  question: "How can we verify this hypothesis?"
  header: "Verification"
  options:
    - label: "Add logging"
      description: "Add console.log to see actual values"
    - label: "Use debugger"
      description: "Set breakpoint and step through"
    - label: "Write a test"
      description: "Create a unit test for this scenario"
    - label: "Try simpler input"
      description: "Test with minimal/known-good data"
    - label: "You suggest"
      description: "Recommend the best approach"
```

### 5.2 Gather Evidence

Based on chosen approach, gather information:

**If adding logging:**
```typescript
console.log('[DEBUG] Variable value:', variable)
console.log('[DEBUG] Function input:', input)
console.log('[DEBUG] State at this point:', state)
```

**If using tests:**
```typescript
describe('problematic function', () => {
  it('should handle the edge case', () => {
    const input = /* edge case data */
    const result = problematicFunction(input)
    expect(result).toEqual(/* expected */)
  })
})
```

### 5.3 Analyze Results

```
AskUserQuestion:
  question: "What did you learn from the investigation?"
  header: "Findings"
  options:
    - label: "Found the bug!"
      description: "I now see exactly what's wrong"
    - label: "Narrowed it down"
      description: "Ruled out some possibilities"
    - label: "Need different approach"
      description: "This didn't help, try something else"
    - label: "More confused"
      description: "Results don't make sense"
```

## Phase 6: Solution

### 6.1 Confirm Understanding

Before fixing, confirm:

```markdown
## Problem Summary

**Expected**: [What should happen]
**Actual**: [What actually happens]
**Root Cause**: [Why it's happening]
**Fix**: [What needs to change]
```

```
AskUserQuestion:
  question: "Does this summary accurately describe the issue?"
  header: "Confirm"
  options:
    - label: "Yes, that's right"
      description: "Please proceed with the fix"
    - label: "Partially correct"
      description: "Let me clarify some points"
    - label: "No, that's wrong"
      description: "I think it's something else"
```

### 6.2 Implement Fix

If confirmed, create a plan:

```
TodoWrite:
  todos:
    - content: "Confirm problem understanding"
      activeForm: "Confirming problem"
      status: "completed"
    - content: "Implement the fix"
      activeForm: "Implementing fix"
      status: "pending"
    - content: "Verify fix works"
      activeForm: "Verifying fix"
      status: "pending"
```

### 6.3 Verify Fix

After implementing:

```
AskUserQuestion:
  question: "Does the fix work?"
  header: "Verification"
  options:
    - label: "Yes, it works!"
      description: "Problem solved"
    - label: "Partially"
      description: "Better but not fully fixed"
    - label: "No"
      description: "Still broken, need to try again"
    - label: "New problem"
      description: "Fixed original but introduced new issue"
```

## Phase 7: Wrap-Up

### 7.1 Document the Learning

```markdown
## Bug Resolved

**Problem**: [Original issue]
**Root Cause**: [What was actually wrong]
**Solution**: [What fixed it]
**Key Insight**: [What made the difference]
**Prevention**: [How to avoid this in the future]
```

### 7.2 Reflect

```
AskUserQuestion:
  question: "What was the key insight that led to the solution?"
  header: "Reflection"
  options:
    - label: "Explaining the code revealed it"
      description: "Walking through line-by-line exposed the bug"
    - label: "Checking assumptions"
      description: "An assumption I had was wrong"
    - label: "Looking at data"
      description: "Seeing actual values showed the problem"
    - label: "Fresh perspective"
      description: "Stepping back helped me see it"
```

### 7.3 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Add tests"
      description: "Write tests to prevent regression"
    - label: "Debug another issue"
      description: "Work through another problem"
    - label: "Commit the fix"
      description: "Run /git:commit to save changes"
    - label: "Done"
      description: "I'm all set"
```

## Quick Reference

### The Rubber Duck Method

1. **Explain what the code should do** in plain language
2. **Walk through the code line-by-line** explaining each part
3. **State your assumptions** about inputs, state, dependencies
4. **Compare expected vs actual** at each step
5. **The discrepancy reveals the bug**

### Questions That Reveal Bugs

- "What value does this variable have at this point?"
- "What happens if this is null/undefined?"
- "Is this async operation awaited?"
- "What order do these operations happen in?"
- "What state is the component in when this runs?"

### Common Revelations

| Articulation | Revelation |
|--------------|------------|
| "It should return..." | "Oh, I forgot the return statement!" |
| "This assumes..." | "But that assumption is wrong here!" |
| "Then it calls..." | "Wait, that's not awaited!" |
| "If x is true..." | "Oh, I used = instead of ===" |
| "The data comes from..." | "That field is spelled differently!" |

## Important Behaviors

1. **GUIDE** the user through explaining their code
2. **LISTEN** for assumptions and contradictions
3. **ASK** probing questions about values and state
4. **EXPLAIN** the code back to verify understanding
5. **DON'T** jump to solutions - let articulation reveal the bug
6. **CELEBRATE** when the user finds the bug themselves

## The Power of Articulation

Research shows that the act of explaining forces you to:
- Think through logic sequentially
- Surface implicit assumptions
- Notice gaps in understanding
- Catch inconsistencies

Often, the solution becomes obvious mid-explanation. The rubber duck doesn't need to respond - the act of explaining is what matters.
