---
description: Debug and fix browser issues by inspecting, diagnosing, and resolving visual or technical problems
argument-hint: "[issue-description] [--url <url>]"
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, Task, TodoWrite, AskUserQuestion, Skill, mcp__playwright__browser_snapshot, mcp__playwright__browser_navigate, mcp__playwright__browser_console_messages, mcp__playwright__browser_network_requests, mcp__playwright__browser_click, mcp__playwright__browser_type, mcp__playwright__browser_resize, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_evaluate, mcp__context7__resolve-library-id, mcp__context7__get-library-docs
---

# Browser Debug

Debug and resolve issues observed in the browser. Handles visual problems (design system violations, layout issues) and technical problems (console errors, interaction failures, data issues).

## Arguments

Parse `$ARGUMENTS`:
- If `--url <url>` flag provided, extract the URL
- Remaining text is the issue description
- Both are optional; prompt if missing

## Phase 1: Issue Intake

### 1.1 Gather Missing Information

**If URL not provided**, ask:
```
AskUserQuestion:
  question: "What URL should I navigate to?"
  header: "URL"
  options:
    - label: "localhost:3000"
      description: "Home page"
    - label: "localhost:3000/accounts"
      description: "Accounts page"
    - label: "localhost:3000/transactions"
      description: "Transactions page"
```

**If description not provided or vague**, ask about issue type:
```
AskUserQuestion:
  question: "What type of issue are you seeing?"
  header: "Issue Type"
  multiSelect: false
  options:
    - label: "Visual/Layout"
      description: "Wrong spacing, fonts, colors, alignment, or design inconsistency"
    - label: "Interaction"
      description: "Button, form, or link not working as expected"
    - label: "Data Display"
      description: "Wrong data, stale content, or loading issues"
    - label: "Responsive"
      description: "Looks wrong on certain screen sizes"
```

### 1.2 Additional Context

Ask follow-up questions:
```
AskUserQuestion:
  question: "When did you first notice this issue?"
  header: "Timeline"
  options:
    - label: "Just now"
      description: "Started in current session"
    - label: "After recent changes"
      description: "Noticed after code modifications"
    - label: "Intermittent"
      description: "Happens sometimes, not consistently"
    - label: "Always"
      description: "Consistent behavior"
```

## Phase 2: Initial Assessment

### 2.1 Pre-flight Checks

```bash
# Check if dev server is running
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
  echo "⚠️  Dev server not responding. Check that 'pnpm dev' is running."
fi

# Check latest dev server log for errors
LATEST_LOG=$(ls -t .logs/ 2>/dev/null | head -1)
if [ -n "$LATEST_LOG" ]; then
  echo "📋 Recent server log entries:"
  grep -i "error\|failed\|exception" ".logs/$LATEST_LOG" | tail -10
fi
```

### 2.2 Navigate and Capture Initial State

```
mcp__playwright__browser_navigate: { url: "[provided-url]" }
mcp__playwright__browser_snapshot: {}
mcp__playwright__browser_console_messages: { level: "debug" }
mcp__playwright__browser_network_requests: { includeStatic: false }
```

### 2.3 Check Dev Server Logs

```bash
# Read latest log for context
cat ".logs/$(ls -t .logs/ | head -1)" | tail -50
```

### 2.4 Classify Issue Type

Based on gathered data, classify the issue:

| Classification | Indicators |
|----------------|------------|
| **Visual** | No console errors, visual discrepancy from design system |
| **Interaction** | Console errors on action, event handler issues |
| **Data** | API failures, wrong response shape, stale cache |
| **Performance** | Slow loading, console timing warnings |
| **Responsive** | Layout shifts at breakpoints |

## Phase 3: Deep Diagnosis

### 3.0 Parallel Diagnostic Agents (Optional)

When the issue is complex or unclear, launch parallel diagnostic agents:

```
# Launch all diagnostic agents simultaneously
visual_agent = Task(
  description: "Audit visual/design system compliance",
  prompt: """
    Conduct a systematic design system audit for the affected area.

    Check against the Calm Tech design system:
    1. Typography: Geist Sans/Mono, correct sizes (11/13/15/17/20/24/30/36/48px)
    2. Spacing: 8px base (4/8/12/16/20/24/32/48/64px)
    3. Colors: No pure black/white, semantic tokens used
    4. Shapes: Cards rounded-xl (16px), buttons rounded-md (10px)
    5. Shadows: Using project shadows (shadow-soft, shadow-elevated)
    6. Animation: 100-300ms duration, correct easing

    Return findings in this format:
    ## Visual Audit Findings
    **Area Audited**: [description]
    **Violations Found**: [count]
    **Details**:
    - [violation 1]
    - [violation 2]
    **Severity**: [High/Medium/Low]
  """,
  subagent_type: "general-purpose",
  run_in_background: true
)

console_agent = Task(
  description: "Analyze console errors and warnings",
  prompt: """
    Analyze browser console for errors related to the issue.

    1. Review all console errors from the page
    2. Check for React warnings (key props, deprecated lifecycle)
    3. Look for uncaught exceptions
    4. Check for network-related console messages
    5. Identify the source component/file for each error

    Return findings in this format:
    ## Console Analysis Findings
    **Total Errors**: [count]
    **Critical Errors**:
    - [error message] → [source file]
    **Warnings**: [count]
    **Likely Root Cause**: [explanation]
  """,
  subagent_type: "typescript-expert",
  run_in_background: true
)

network_agent = Task(
  description: "Analyze network requests and responses",
  prompt: """
    Analyze network activity for issues.

    1. Check for failed requests (4xx, 5xx status codes)
    2. Look for slow requests (>2 seconds)
    3. Verify response shapes match expected
    4. Check for CORS issues
    5. Look for missing requests that should be made

    Return findings in this format:
    ## Network Analysis Findings
    **Failed Requests**: [count]
    **Details**:
    - [URL] → [status] [error]
    **Slow Requests**: [count]
    **Missing Requests**: [any expected but not made]
    **Likely Issue**: [explanation]
  """,
  subagent_type: "general-purpose",
  run_in_background: true
)

accessibility_agent = Task(
  description: "Check accessibility issues",
  prompt: """
    Check for accessibility issues in the affected area.

    1. Check for missing alt text on images
    2. Verify form labels are associated with inputs
    3. Check color contrast (WCAG AA: 4.5:1)
    4. Verify focus states are visible
    5. Check for keyboard navigation issues
    6. Verify ARIA attributes are correct

    Return findings in this format:
    ## Accessibility Findings
    **Issues Found**: [count]
    **Critical**:
    - [issue description]
    **Warnings**:
    - [issue description]
    **Recommendations**: [list]
  """,
  subagent_type: "general-purpose",
  run_in_background: true
)

# Display progress
print("🔍 Running parallel browser diagnostics...")
print("   → Visual/design system audit")
print("   → Console error analysis")
print("   → Network request analysis")
print("   → Accessibility check")

# Collect results
visual_result = TaskOutput(task_id: visual_agent.id, block: true)
print("   ✅ Visual audit complete")

console_result = TaskOutput(task_id: console_agent.id, block: true)
print("   ✅ Console analysis complete")

network_result = TaskOutput(task_id: network_agent.id, block: true)
print("   ✅ Network analysis complete")

accessibility_result = TaskOutput(task_id: accessibility_agent.id, block: true)
print("   ✅ Accessibility check complete")

# Synthesize findings
print("\n📊 Diagnostic Summary:")
# Present combined findings, prioritize by severity
```

**Benefits**:
- 4x faster than sequential checks
- Each agent specializes in its domain
- Comprehensive coverage without context overload

---

### For Visual Issues

**Invoke the `designing-frontend` skill:**
```
Skill: { skill: "designing-frontend" }
```

**Conduct systematic Design System Audit:**

#### 1. Typography Audit
- [ ] Is font Geist Sans/Mono? (no Inter, Roboto, Arial)
- [ ] Does size match type scale? (11/13/15/17/20/24/30/36/48px)
- [ ] Is weight appropriate? (400+ for body, 500-700 for headings)
- [ ] Is letter-spacing correct for display text? (-0.02em to -0.025em)

#### 2. Spacing Audit
- [ ] Does spacing follow 8px base? (4/8/12/16/20/24/32/48/64px)
- [ ] Is card padding 24px (p-6)?
- [ ] Are gaps 16px default, 24px for card grids?

#### 3. Color Audit
- [ ] No pure black (#000) or white (#fff)?
- [ ] Using semantic tokens (bg-primary, text-muted-foreground)?
- [ ] WCAG AA contrast met (4.5:1 for text)?

#### 4. Shape Audit
- [ ] Cards using rounded-xl (16px)?
- [ ] Buttons using rounded-md (10px)?
- [ ] Inputs matching button radius?

#### 5. Shadow Audit
- [ ] Using project shadows (shadow-soft, shadow-elevated, shadow-floating)?
- [ ] Shadows diffused, not harsh?

#### 6. Animation Audit (if applicable)
- [ ] Duration between 100-300ms?
- [ ] Correct easing curve? (ease-out for enter, ease-in for exit)
- [ ] prefers-reduced-motion respected?

**Take targeted screenshot if needed:**
```
mcp__playwright__browser_take_screenshot: {
  element: "[description of element]",
  ref: "[ref from snapshot]"
}
```

### For Interaction Issues

1. **Attempt the interaction:**
```
mcp__playwright__browser_click: {
  element: "[description]",
  ref: "[ref]"
}
```

2. **Check console for new errors:**
```
mcp__playwright__browser_console_messages: { level: "error" }
```

3. **Evaluate the result:**
```
mcp__playwright__browser_snapshot: {}
```

4. **Trace component code path** to find event handlers

### For Data Issues

1. **Check network request details:**
```
mcp__playwright__browser_network_requests: { includeStatic: false }
```

2. **Check server logs for API errors:**
```bash
grep -E "POST|GET|error|failed" ".logs/$(ls -t .logs/ | head -1)" | tail -20
```

3. **Trace data flow in code:**
   - Find the component displaying the data
   - Find the TanStack Query hook or server action
   - Find the DAL function
   - Check for cache invalidation issues

### For Responsive Issues

**Test at key breakpoints:**
```
mcp__playwright__browser_resize: { width: 375, height: 667 }   # Mobile
mcp__playwright__browser_snapshot: {}

mcp__playwright__browser_resize: { width: 768, height: 1024 }  # Tablet
mcp__playwright__browser_snapshot: {}

mcp__playwright__browser_resize: { width: 1280, height: 800 }  # Desktop
mcp__playwright__browser_snapshot: {}
```

**Check for:**
- Responsive class usage (sm:, md:, lg:, xl:)
- Touch targets (minimum 44px)
- Content overflow issues

## Phase 4: Root Cause Analysis

### 4.1 State the Issue Clearly

```markdown
**Observed:** [What you see]
**Expected:** [What it should be according to design system/spec]
**Impact:** [User experience impact]
```

### 4.2 Trace to Source Code

**For complex searches**, use code-search agent:
```
Task:
  description: "Find [component/function]"
  subagent_type: "code-search"
  prompt: "Find the source code for [specific element]. Look for: [search terms]"
```

**For simpler cases**, use direct search:
```
Glob: { pattern: "**/[component-name]*" }
Grep: { pattern: "[search-term]", type: "tsx" }
```

### 4.3 Validate Assumptions

**BEFORE making changes:**
- Read the relevant component code
- Understand the data flow
- Check for intentional design decisions
- Look for comments explaining choices

### 4.4 Research If Needed

**For library issues:**
```
mcp__context7__resolve-library-id: { libraryName: "[library]" }
mcp__context7__get-library-docs: {
  context7CompatibleLibraryID: "[id]",
  topic: "[specific issue]"
}
```

**For complex issues**, spawn research agent:
```
Task:
  description: "Research [issue]"
  subagent_type: "research-expert"
  prompt: "Research how to [solve specific problem]. Focus on [specifics]."
```

## Phase 5: Implementation

### 5.1 Create Mini-Plan

Document 3-5 steps maximum:
```
TodoWrite:
  todos:
    - content: "[Step 1]"
      activeForm: "[Step 1 active]"
      status: "pending"
    - content: "[Step 2]"
      activeForm: "[Step 2 active]"
      status: "pending"
```

### 5.2 Make Changes

For each change:
1. **Read the file first** - never edit without reading
2. **Make targeted edits** - minimal changes to fix the issue
3. **Verify syntax** with typecheck
4. **Mark task complete** as you go

### 5.3 Verify Build

```bash
pnpm typecheck
pnpm lint
```

## Phase 6: Verification

### 6.1 Test the Fix

```
mcp__playwright__browser_navigate: { url: "[url]" }
mcp__playwright__browser_snapshot: {}
```

### 6.2 Compare Results

- Does the issue appear resolved?
- Are there any new console errors?
- Did the fix introduce visual regressions?

### 6.3 Test Edge Cases

Based on issue type:
- **Visual:** Check dark mode, responsive sizes
- **Interaction:** Test success and error states
- **Data:** Test loading, empty, and error states

### 6.4 If Issue Persists

Continue debugging:
1. Review what was learned
2. Identify what was missed
3. Try alternative approach
4. Ask user for more context if stuck

**Do not give up after one attempt. Iterate until resolved or blocked.**

## Phase 7: Wrap-Up

### 7.1 Summarize the Fix

```markdown
## Issue Resolved

**Problem:** [Original issue description]
**Root Cause:** [What caused it]
**Solution:** [What was changed]
**Files Modified:** [List of files]
```

### 7.2 Suggest Improvements (Optional)

If noticed during debugging:
- Related components with same issue
- Opportunities to use design tokens
- Missing component variants
- Potential refactoring

### 7.3 Recommend Regression Prevention

Suggest:
- Component test for the fix
- Visual regression test consideration
- Design token usage to prevent future issues

### 7.4 Offer Next Steps

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Steps"
  options:
    - label: "Test another issue"
      description: "Continue debugging something else"
    - label: "Commit the fix"
      description: "Run /git:commit to stage and commit changes"
    - label: "Done"
      description: "I'm satisfied with the fix"
```

## Quick Reference

### Common Design System Violations

| Issue | Check | Fix |
|-------|-------|-----|
| Wrong font | `font-sans` class missing | Add `font-sans` or check font loading |
| Harsh borders | Pure black/white colors | Use `border-border` or theme colors |
| Cramped cards | Padding < 24px | Use `p-6` for card padding |
| Square corners | Wrong radius | Cards: `rounded-xl`, Buttons: `rounded-md` |
| Hard shadows | Non-diffused shadows | Use `shadow-soft` or `shadow-elevated` |
| Giant text | Wrong scale level | Match to type scale (11/13/15/17/20/24/30/36px) |
| Janky animation | Wrong duration/easing | 100-300ms, ease-out for enter |

### Agent Usage

Use specialized agents when needed:

| Scenario | Agent |
|----------|-------|
| Complex CSS/layout | `react-tanstack-expert` |
| Type errors found | `typescript-expert` |
| Database/API issues | `prisma-expert` |
| Deep research needed | `research-expert` |
| Multi-file search | `code-search` |

### Skills to Invoke

- `designing-frontend` - For visual audits and design system compliance
- `using-tailwind-shadcn` - For styling patterns and component specs

### Emergency Shortcuts

For quick fixes when you know the issue:

```bash
# Find component by name
rg -l "ComponentName" src/

# Find all styling for element
rg "className.*element-name" src/

# Check dark mode variant
rg "dark:" src/path/to/file.tsx

# Find Tailwind classes
rg "rounded-|shadow-|text-|bg-|p-|m-" src/path/to/file.tsx
```

## Important Behaviors

1. **ALWAYS** take a browser snapshot before making changes
2. **ALWAYS** read component code before editing
3. **ALWAYS** validate design system compliance for visual issues
4. **ALWAYS** check console logs and network requests
5. **ALWAYS** verify the fix in the browser after changes
6. **ITERATE** if the fix doesn't work - don't give up after one attempt
7. **OFFER** to continue if issues persist
8. **ESCALATE** complex issues - offer to create a spec via `/spec:create`

## Edge Cases

- **Dev server not running**: Prompt user to start it with `pnpm dev`
- **URL returns 404/500**: Check route exists, check for server errors
- **Hot reload issues**: Suggest hard refresh or dev server restart
- **Multiple issues detected**: Prioritize, fix one at a time, track with TodoWrite
- **Issue is too complex**: Offer to create a proper spec with `/spec:create`
