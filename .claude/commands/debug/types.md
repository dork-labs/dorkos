---
description: Debug and fix TypeScript type errors with systematic analysis and expert guidance
argument-hint: "[error-message or file-path]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, mcp__context7__resolve-library-id, mcp__context7__get-library-docs
---

# TypeScript Type Error Debugging

Systematically debug and resolve TypeScript type errors using evidence-based techniques. This command helps with type inference issues, complex generics, union type problems, and cryptic compiler errors.

## Arguments

Parse `$ARGUMENTS`:
- If argument looks like an error message, use it as the starting point
- If argument is a file path, run typecheck on that file
- If empty, run full typecheck and analyze errors

## Phase 1: Error Collection

### 1.1 Gather Type Errors

If no specific error provided, run typecheck:

```bash
pnpm typecheck 2>&1 | head -100
```

### 1.2 Clarify the Problem

If multiple errors found, ask which to focus on:

```
AskUserQuestion:
  question: "I found multiple type errors. Which would you like to tackle first?"
  header: "Error Focus"
  options:
    - label: "First error"
      description: "Start with the first error in the list"
    - label: "Most critical"
      description: "Let me identify the root cause error"
    - label: "Specific file"
      description: "I'll tell you which file to focus on"
```

### 1.3 Understand Context

Ask about the error context:

```
AskUserQuestion:
  question: "When did this error start appearing?"
  header: "Timeline"
  options:
    - label: "After recent changes"
      description: "Started after I modified some code"
    - label: "After updating dependencies"
      description: "Started after npm/pnpm update"
    - label: "After pulling new code"
      description: "Started after git pull"
    - label: "Always been there"
      description: "It's been failing for a while"
```

## Phase 2: Error Analysis

### 2.1 Parse the Error

Extract key information from the TypeScript error:
- **Error code** (e.g., TS2322, TS2345, TS2741)
- **File and line number**
- **Expected type** vs **Actual type**
- **Context** (function call, assignment, return statement)

### 2.2 Classify Error Type

Common TypeScript error categories:

| Error Code | Category | Common Cause |
|------------|----------|--------------|
| TS2322 | Type mismatch | Assigning wrong type to variable |
| TS2345 | Argument type | Wrong type passed to function |
| TS2339 | Property missing | Accessing non-existent property |
| TS2741 | Missing property | Object literal missing required property |
| TS2352 | Type assertion | Invalid type assertion |
| TS2589 | Infinite type | Recursive type too deep |
| TS7006 | Implicit any | Parameter has implicit 'any' type |
| TS2307 | Module not found | Import path doesn't resolve |

### 2.3 Read the Source Code

**CRITICAL**: Always read the file before proposing fixes.

```
Read the file at the error location.
Understand the surrounding context.
Look for type definitions, interfaces, and generics involved.
```

## Phase 3: Root Cause Investigation

### 3.1 Apply Chain-of-Thought Analysis

Think through the error step-by-step:

1. **What type is expected?** (from function signature, interface, or type annotation)
2. **What type is being provided?** (trace back to the source)
3. **Where is the mismatch?** (specific property, generic parameter, union branch)
4. **Why does the mismatch exist?** (wrong data, missing transform, incorrect type definition)

### 3.2 Check Related Types

Search for type definitions:

```bash
# Find type/interface definitions
rg "type\s+TypeName|interface\s+TypeName" src/ --type ts

# Find where the type is used
rg "TypeName" src/ --type ts -l
```

### 3.3 Investigate Type Inference

For type inference issues, check:

- [ ] Is the variable initialized without explicit type?
- [ ] Is there type widening (literal → string)?
- [ ] Are generics being inferred incorrectly?
- [ ] Is there a union type causing ambiguity?

### 3.4 Ask Clarifying Questions

If the fix approach is unclear:

```
AskUserQuestion:
  question: "How would you like to resolve this type mismatch?"
  header: "Fix Approach"
  options:
    - label: "Fix the data"
      description: "Change the code to provide the correct type"
    - label: "Fix the type definition"
      description: "Update the interface/type to accept this data"
    - label: "Add type guard"
      description: "Add runtime check to narrow the type"
    - label: "Use type assertion"
      description: "Assert the type (last resort)"
```

## Phase 4: Common Fixes

### 4.1 Type Widening Fix

**Problem**: `let status = "success"` infers `string` instead of `"success"`

**Fix**: Use `as const` or explicit type annotation
```typescript
const status = "success" as const
// or
let status: "success" | "error" = "success"
```

### 4.2 Union Type Narrowing

**Problem**: Can't access property that only exists on one branch of union

**Fix**: Add type guard
```typescript
if ('propertyName' in obj) {
  // TypeScript now knows obj has propertyName
}
// or
if (obj.kind === 'specific') {
  // Discriminated union narrowing
}
```

### 4.3 Generic Inference Fix

**Problem**: Generic parameter inferred as `unknown` or wrong type

**Fix**: Provide explicit type parameter
```typescript
// Instead of: getData(id)
// Use: getData<UserType>(id)
```

### 4.4 Missing Property Fix

**Problem**: Object literal missing required property

**Fix Options**:
1. Add the missing property
2. Make property optional in interface (`property?: type`)
3. Use `Partial<Type>` if appropriate

### 4.5 Deep Type Instantiation

**Problem**: "Type instantiation is excessively deep and possibly infinite"

**Fix**: Simplify recursive types, add explicit type annotations at recursion points

## Phase 5: Implementation

### 5.1 Plan the Fix

Create a mini-plan:

```
TodoWrite:
  todos:
    - content: "Read and understand the type definitions involved"
      activeForm: "Reading type definitions"
      status: "pending"
    - content: "Implement the type fix"
      activeForm: "Implementing type fix"
      status: "pending"
    - content: "Verify fix with typecheck"
      activeForm: "Verifying typecheck passes"
      status: "pending"
```

### 5.2 Make Changes

For each change:
1. **Read the file first** - never edit without reading
2. **Make targeted edits** - minimal changes to fix the error
3. **Preserve existing patterns** - follow project conventions

### 5.3 Verify the Fix

```bash
pnpm typecheck
```

Check that:
- The original error is resolved
- No new errors were introduced
- Related code still works

## Phase 6: Complex Cases

### 6.1 When to Use typescript-expert Agent

For complex cases, spawn the specialist:

```
Task:
  description: "Debug complex TypeScript type error"
  subagent_type: "typescript-expert"
  prompt: |
    Analyze this TypeScript error and propose a fix:

    Error: [paste error]
    File: [file path]

    Context: [what the code is trying to do]

    Please:
    1. Explain why this error occurs
    2. Propose the best fix
    3. Consider alternative approaches
```

### 6.2 Research Library Types

For errors involving third-party libraries:

```
mcp__context7__resolve-library-id: { libraryName: "[library]" }
mcp__context7__get-library-docs: {
  context7CompatibleLibraryID: "[id]",
  topic: "types"
}
```

## Phase 7: Wrap-Up

### 7.1 Summarize

```markdown
## Type Error Resolved

**Error**: [Original error code and message]
**Root Cause**: [Why the error occurred]
**Solution**: [What was changed]
**Files Modified**: [List of files]
```

### 7.2 Educational Note

Explain the underlying TypeScript concept to help prevent future errors.

### 7.3 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Fix another type error"
      description: "Continue debugging other type issues"
    - label: "Run full typecheck"
      description: "Verify all type errors are resolved"
    - label: "Commit the fix"
      description: "Run /git:commit to save changes"
    - label: "Done"
      description: "I'm satisfied with the fix"
```

## Quick Reference

### Common Error Codes

| Code | Meaning | Quick Fix |
|------|---------|-----------|
| TS2322 | Type 'X' is not assignable to type 'Y' | Check type compatibility |
| TS2345 | Argument type mismatch | Verify function signature |
| TS2339 | Property doesn't exist | Check spelling, add to interface |
| TS2532 | Object possibly undefined | Add null check or optional chaining |
| TS2571 | Object is of type 'unknown' | Add type guard or assertion |
| TS7006 | Implicit any | Add type annotation |
| TS2307 | Cannot find module | Check import path, install types |

### Project-Specific Patterns

This project uses:
- **Zod schemas** for runtime validation (`z.infer<typeof schema>`)
- **Prisma types** from `@/generated/prisma`
- **TanStack Query** with typed hooks
- **Server Actions** with typed returns

## Important Behaviors

1. **ALWAYS** read the source file before proposing fixes
2. **NEVER** use `any` to silence errors (project rule)
3. **PREFER** type guards over type assertions
4. **EXPLAIN** why the error occurs, not just how to fix it
5. **CHECK** for cascading effects from type changes
6. **VERIFY** with `pnpm typecheck` after changes

## Edge Cases

- **Circular type references**: Break the cycle with explicit type annotations
- **Conditional types**: Simplify or use type helpers
- **Mapped types**: Check source type is correct
- **Template literal types**: Verify string patterns match
