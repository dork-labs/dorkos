---
description: Learn new capabilities through experimentation, then codify into the system
argument-hint: [topic to learn or behavior to codify]
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, WebSearch, WebFetch, AskUserQuestion, TodoWrite, SlashCommand, Task
---

# System Learn Command

Learn new capabilities through trial and error experimentation, then codify successful behaviors into the system. This command acts as a collaborative learning partner.

## Arguments

- `$ARGUMENTS` - What to learn or codify. Examples:
  - Proactive: "learn how to interact with contacts using applescript"
  - Retrospective: "we successfully created calendar events with smart defaults - codify this"

## Mode Detection

Detect which mode based on the user's instructions:

**Proactive mode** (experimentation first):
- Keywords: "learn how to", "figure out how to", "try to", "experiment with", "discover how"
- Flow: Research → Experiment → Iterate → Codify

**Retrospective mode** (codify what worked):
- Keywords: "we just", "we successfully", "codify this", "what we did", "save this behavior", "remember how we"
- Flow: Analyze → Codify

## Order of Operations

Execute these phases sequentially. This is an **interactive, collaborative** process.

### Phase 1: Understanding

- [ ] **1.1** Parse `$ARGUMENTS` to detect mode (proactive vs retrospective)

- [ ] **1.2** For **Proactive mode**:
  - Ask clarifying questions to understand the goal
  - Define testable success criteria together with the user
  - Present what we'll be experimenting with
  - Get upfront consent: "This will involve experimentation. I'll try different approaches and ask for your feedback. Ready to proceed?"

- [ ] **1.3** For **Retrospective mode**:
  - Confirm what was accomplished: "It sounds like we successfully [X]. Is that what you'd like to codify?"
  - Clarify the scope: What specific behavior should be captured?
  - Identify the key patterns that made it work

### Phase 2: Research

- [ ] **2.1** Search for related existing behaviors in the system:
  ```
  # Check existing skills
  Search .claude/skills/ for related patterns

  # Check existing commands
  Search .claude/commands/ for related functionality

  # Check hooks (configured in settings.json)
  Read .claude/settings.json for hook configurations

  # Check existing agents
  Search .claude/agents/ for related expertise

  # Check CLAUDE.md for documented behaviors
  Read CLAUDE.md and search for related keywords
  ```

- [ ] **2.2** Check for potential conflicts or enhancements:
  - Does this duplicate something that exists?
  - Does this enhance an existing behavior?
  - Does this conflict with an existing behavior?

- [ ] **2.3** Research the domain:
  - Web search for documentation, examples, best practices
  - Look for existing patterns in the codebase
  - Understand the APIs, tools, or systems involved

- [ ] **2.4** Report research findings:
  ```markdown
  ## Research Findings

  ### Existing Related Behaviors
  - [List any related skills/commands/hooks found]

  ### Domain Knowledge
  - [Key information learned about the topic]

  ### Potential Approach
  - [Initial idea for how to accomplish this]
  ```

### Phase 3: Learning Loop (Proactive Mode Only)

Skip this phase for retrospective mode.

- [ ] **3.1** Start the experimentation loop:

```
┌─────────────────────────────────────────┐
│ 1. Try an approach                       │
│ 2. Report results (worked/didn't work)  │
│ 3. Get user feedback                     │
│ 4. Adjust approach based on feedback    │
│ 5. Repeat until success criteria met    │
└─────────────────────────────────────────┘
```

- [ ] **3.2** For each experiment:
  - Explain what we're about to try
  - Execute the experiment
  - Report results clearly: what worked, what didn't
  - Ask for user feedback: "Did that work as expected? Any adjustments needed?"

- [ ] **3.3** Track learnings throughout:
  - What approaches failed and why
  - What approaches worked and why
  - Key insights discovered

- [ ] **3.4** **Risk Assessment** - Before attempting anything particularly risky, ask for additional consent:
  - System-level changes
  - Destructive operations
  - Operations that can't be easily undone
  - External service interactions

  Use: "This next step involves [risky thing]. Want me to proceed?"

- [ ] **3.5** When success criteria are met:
  - Confirm with user: "This appears to be working. Ready to codify this behavior?"
  - Summarize what we learned

### Phase 4: Codification Planning

- [ ] **4.1** Determine what type of component to create:

  | If the behavior... | Create a... |
  |-------------------|-------------|
  | Should be available automatically when context matches | **Skill** (default) |
  | User should explicitly trigger it | **Command** |
  | Must happen at specific lifecycle events | **Hook** |
  | Needs context isolation for complex tasks | **Agent** |
  | Is a file structure pattern | **Template** |
  | Is core system knowledge | **CLAUDE.md update** |

  **Default to Skill** unless there's a clear reason for another type.
  Only ask the user if it's genuinely unclear which type is best.

- [ ] **4.2** Check for conflicts with existing behaviors:

  **Minor enhancement** (inform and proceed):
  - New behavior builds on existing
  - Adds capability without changing existing behavior
  - → "This will enhance the existing [X] behavior by adding [Y]. Proceeding."

  **Major conflict** (stop and ask):
  - New behavior contradicts existing
  - Would override or replace existing behavior
  - → Use AskUserQuestion: "This conflicts with [existing behavior]. How should we handle this?"
    - Replace the existing behavior
    - Modify the existing behavior to accommodate both
    - Keep both as separate behaviors
    - Cancel codification

- [ ] **4.3** Plan the implementation:
  - What files will be created/modified?
  - What should the content include?
  - What documentation updates are needed?

### Phase 5: Execute Codification

- [ ] **5.1** Generate detailed instructions for `/system:update`:

  Include in the instructions:
  - What was learned (the successful approach)
  - What type of component to create
  - Specific implementation details
  - Any enhancements to existing behaviors
  - Success criteria for testing

- [ ] **5.2** Invoke `/system:update` with the instructions:
  ```
  /system:update [detailed instructions based on learnings]
  ```

- [ ] **5.3** Let `/system:update` handle:
  - File creation/modification
  - Documentation updates
  - Validation and review

### Phase 6: Verification

- [ ] **6.1** Test the codified behavior:
  - Try using the new skill/command/hook
  - Verify it works as expected
  - Check edge cases if applicable

- [ ] **6.2** Report completion:
  ```markdown
  ## Learning Complete

  ### What We Learned
  - [Summary of key insights]

  ### What Was Codified
  - [Component type]: [name]
  - Location: [file path]

  ### How to Use
  - [Instructions for using the new behavior]

  ### Testing
  - Tested: [what was tested]
  - Result: [passed/failed]
  ```

- [ ] **6.3** Confirm with user:
  - "The behavior has been codified and tested. Anything else to adjust?"

## Interaction Guidelines

- **Be a learning partner** - This is collaborative, not mechanical
- **Explain your thinking** - Share why you're trying certain approaches
- **Fail fast, learn quickly** - Don't spend too long on approaches that aren't working
- **Celebrate progress** - Acknowledge when things work
- **Stay focused** - Don't scope creep during experimentation
- **Default to skills** - Prefer model-invoked over user-invoked when appropriate
- **Improve, don't just add** - Look for opportunities to enhance existing behaviors rather than creating new ones

## Examples

### Proactive Learning

```
User: /system:learn learn how to interact with contacts using applescript

Claude: I'll help you learn how to interact with macOS Contacts using AppleScript.

## Understanding

**Goal**: Interact with Contacts.app via AppleScript
**Success criteria**:
- Can read contacts
- Can search by name
- Can create/update contacts

**Research findings**: [shows what was found]

Ready to start experimenting?

[User confirms]

**Experiment 1**: Let me try reading all contacts...
[Shows results, asks for feedback]

**Experiment 2**: Based on that, let me try searching...
[Iterates until success]

**Codification**: This worked well. I'll codify this as a skill...
[Invokes /system:update]
```

### Retrospective Codification

```
User: /system:learn we just successfully created calendar events with travel time - codify this

Claude: I see we successfully created calendar events with automatic travel time. Let me codify this behavior.

## Confirming What Worked

You want me to codify the pattern for:
- Creating calendar events
- Automatically adding travel time before events with locations

Is that correct?

[User confirms]

## Research

Checking for related behaviors...
- Found: `calendar-management` skill exists
- This would enhance it by adding travel time logic

This is a minor enhancement to existing behavior. I'll update the calendar-management skill.

[Invokes /system:update with enhancement instructions]
```

## Edge Cases

- **Learning fails repeatedly**: After 3-4 failed attempts, pause and ask user if they want to continue or try a different approach
- **Domain is too complex**: Break into smaller learnable pieces, tackle one at a time
- **Existing behavior is better**: If research reveals existing behavior already does this well, inform user and skip codification
- **User wants to abandon**: Gracefully exit without codifying, optionally save notes about what was tried
