---
description: Debug and fix failing tests using test-driven analysis and self-debugging methodology
argument-hint: "[test-file-path or test-name]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__context7__resolve-library-id, mcp__context7__get-library-docs
---

# Test Failure Debugging

Systematically debug and resolve failing tests using evidence-based self-debugging methodology. This command analyzes test failures, traces to source code, and helps distinguish between test bugs and implementation bugs.

## Arguments

Parse `$ARGUMENTS`:
- If argument is a test file path, run that specific test
- If argument is a test name pattern, find and run matching tests
- If empty, run all tests and analyze failures

## Phase 1: Test Execution

### 1.1 Run Tests

If specific test provided:
```bash
pnpm test [test-file-or-pattern] 2>&1
```

If no argument, run all tests:
```bash
pnpm test 2>&1 | head -200
```

### 1.2 Parse Test Output

Extract from the test output:
- **Failing test names** and their locations
- **Expected vs Actual** values
- **Error messages** and stack traces
- **Test file** and line numbers

### 1.3 Clarify Focus

If multiple tests failing:

```
AskUserQuestion:
  question: "Multiple tests are failing. How would you like to proceed?"
  header: "Test Focus"
  options:
    - label: "Fix first failing test"
      description: "Start with the first failure in order"
    - label: "Find root cause"
      description: "Identify if there's a common cause for multiple failures"
    - label: "Specific test"
      description: "I'll tell you which test to focus on"
    - label: "All related tests"
      description: "Fix all tests in a specific file or feature"
```

### 1.4 Understand Context

```
AskUserQuestion:
  question: "What's the context for these test failures?"
  header: "Context"
  options:
    - label: "Tests were passing before"
      description: "Something changed that broke them"
    - label: "New tests I just wrote"
      description: "Tests I created that aren't passing yet"
    - label: "Tests for new feature"
      description: "Tests for code I'm implementing"
    - label: "Not sure"
      description: "I don't know when they started failing"
```

## Phase 2: Self-Debugging Analysis

Apply the **Self-Debugging Methodology** (evidence-based approach from research):

### 2.1 Read the Failing Test

**CRITICAL**: Always read the test file first.

```
Read the test file at the failure location.
Understand what the test is trying to verify.
Identify the test setup, action, and assertion.
```

### 2.2 Explain the Test Line-by-Line

Walk through the test code and explain:

1. **Setup (Arrange)**: What data/mocks are being prepared?
2. **Action (Act)**: What function/component is being tested?
3. **Assertion (Assert)**: What outcome is expected?

### 2.3 Compare Against Expected Behavior

- What does the test expect to happen?
- What is actually happening?
- Where is the discrepancy?

### 2.4 Determine Bug Location

```
AskUserQuestion:
  question: "Based on my analysis, where do you think the bug is?"
  header: "Bug Location"
  options:
    - label: "Implementation bug"
      description: "The code under test is wrong"
    - label: "Test bug"
      description: "The test itself has an error"
    - label: "Mock/setup issue"
      description: "Test setup or mocks are incorrect"
    - label: "Not sure yet"
      description: "Need more investigation"
```

## Phase 3: Root Cause Investigation

### 3.1 Read the Implementation

Read the source code being tested:

```
Find the function/component under test.
Understand its logic step-by-step.
Trace the data flow from input to output.
```

### 3.2 Check Test Setup

Common test setup issues:

- [ ] Are mocks returning expected values?
- [ ] Is test data complete and valid?
- [ ] Are async operations properly awaited?
- [ ] Is the component properly mounted/rendered?
- [ ] Are dependencies correctly mocked?

### 3.3 Trace the Execution Path

For the failing test:
1. What inputs go into the function?
2. What code path is executed?
3. What intermediate values are produced?
4. Where does the output diverge from expectation?

### 3.4 Check for Common Issues

| Issue | Symptom | Check |
|-------|---------|-------|
| Async timing | Intermittent failures | `await`, `waitFor`, `act` usage |
| Mock not called | Expected call not received | Mock setup and invocation |
| Wrong assertion | Comparing wrong values | Assertion target and matcher |
| State pollution | Test passes alone, fails in suite | Test isolation, cleanup |
| Snapshot mismatch | UI changed | Intentional vs accidental change |

## Phase 4: Fix Strategy

### 4.1 Determine Fix Approach

```
AskUserQuestion:
  question: "How should we fix this issue?"
  header: "Fix Strategy"
  options:
    - label: "Fix the implementation"
      description: "The code under test needs to be corrected"
    - label: "Fix the test"
      description: "The test expectation or setup needs adjustment"
    - label: "Update both"
      description: "Both test and implementation need changes"
    - label: "Update snapshot"
      description: "The snapshot needs to be regenerated"
```

### 4.2 Plan the Fix

```
TodoWrite:
  todos:
    - content: "Read and understand the failing test"
      activeForm: "Reading failing test"
      status: "completed"
    - content: "Read the implementation under test"
      activeForm: "Reading implementation"
      status: "pending"
    - content: "Implement the fix"
      activeForm: "Implementing fix"
      status: "pending"
    - content: "Verify test passes"
      activeForm: "Verifying test passes"
      status: "pending"
```

## Phase 5: Implementation

### 5.1 Make Changes

For each change:
1. **Read the file first** - never edit without reading
2. **Make targeted edits** - fix only what's needed
3. **Keep tests focused** - don't over-test

### 5.2 Run the Test

```bash
pnpm test [specific-test-file] 2>&1
```

### 5.3 Handle Continued Failure

If test still fails:

```
AskUserQuestion:
  question: "The test is still failing. What would you like to do?"
  header: "Next Action"
  options:
    - label: "Analyze new failure"
      description: "The failure message changed, let me re-analyze"
    - label: "Add debugging"
      description: "Add console.log or debugger statements"
    - label: "Check related tests"
      description: "Run related tests to find patterns"
    - label: "Try different approach"
      description: "Let me suggest an alternative fix"
```

## Phase 6: Test Quality Check

### 6.1 Verify Test Coverage

After fixing, check:
- Does the test actually verify the intended behavior?
- Are edge cases covered?
- Is the test isolated (doesn't depend on other tests)?

### 6.2 Check for False Positives

Ensure the test would fail if the implementation was wrong:
- Is the assertion actually checking the right thing?
- Could the test pass with incorrect implementation?

### 6.3 Run Related Tests

```bash
# Run tests in the same file
pnpm test [test-file] 2>&1

# Run tests for the same feature
pnpm test --testPathPattern="[feature-pattern]" 2>&1
```

## Phase 7: Wrap-Up

### 7.1 Summarize

```markdown
## Test Fixed

**Failing Test**: [Test name and file]
**Error**: [Original error message]
**Root Cause**: [Why the test was failing]
**Solution**: [What was changed - test or implementation]
**Files Modified**: [List of files]
```

### 7.2 Lessons Learned

If relevant, note:
- Pattern that caused the issue
- How to prevent similar issues
- Testing best practices reminder

### 7.3 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Run all tests"
      description: "Verify the entire test suite passes"
    - label: "Fix another failing test"
      description: "Continue with other test failures"
    - label: "Add more tests"
      description: "Improve test coverage for this feature"
    - label: "Commit the fix"
      description: "Run /git:commit to save changes"
    - label: "Done"
      description: "I'm satisfied with the fix"
```

## Quick Reference

### Common Test Failures

| Failure Type | Symptom | Quick Fix |
|--------------|---------|-----------|
| Async not awaited | Promise returned | Add `await` or use `waitFor` |
| Mock not called | `expect(mock).toHaveBeenCalled()` fails | Check mock is correctly injected |
| Snapshot mismatch | Snapshot comparison fails | Run `pnpm test -u` to update |
| Timeout | Test times out | Increase timeout, check async logic |
| Type error in test | TypeScript error | Fix type annotations in test |
| Module not found | Import error | Check mock paths, module aliases |

### Testing Patterns in This Project

- **Component tests**: Use `@testing-library/react`
- **Hook tests**: Use `renderHook` from testing-library
- **API tests**: Mock fetch/axios, test DAL functions
- **Server Action tests**: Mock Prisma, test business logic

### Jest/Vitest Matchers

```typescript
expect(value).toBe(exact)           // Strict equality
expect(value).toEqual(deep)         // Deep equality
expect(value).toMatchObject(partial) // Partial match
expect(fn).toHaveBeenCalledWith(args) // Function called with
expect(promise).resolves.toBe(value) // Async resolution
expect(fn).toThrow(error)           // Error thrown
```

## Important Behaviors

1. **ALWAYS** read the test file before proposing fixes
2. **ALWAYS** read the implementation under test
3. **DISTINGUISH** between test bugs and implementation bugs
4. **EXPLAIN** what the test is verifying
5. **VERIFY** fix by running the test
6. **CHECK** that the test would fail if implementation was wrong
7. **NEVER** delete or modify tests just to make them pass without understanding why

## Edge Cases

- **Flaky tests**: Look for race conditions, timing issues
- **Environment-dependent**: Check for hardcoded paths, dates
- **Order-dependent**: Tests should be isolated
- **Snapshot updates**: Confirm UI changes are intentional
