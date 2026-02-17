---
description: Ask how to do something in this repository
argument-hint: [question]
allowed-tools: Read, Grep, Glob, Bash, Skill, SlashCommand, AskUserQuestion, Task, WebSearch
---

# System Help Command

Answer questions about how to accomplish tasks in this repository using Claude Code or manual methods.

## Arguments

- `$ARGUMENTS` - The question about how to do something (e.g., "how do I create a new feature spec?")

## Task

### 1. Research the Answer

Search these sources to find the relevant process:

**Harness README (structure overview)**:

- Read `.claude/README.md` for complete harness inventory and component documentation
- This file documents all commands, agents, skills, rules, and hooks
- Contains architecture diagrams, naming conventions, and maintenance guides

**CLAUDE.md (primary project documentation)**:

- Read the `CLAUDE.md` file in the project root for project instructions and conventions
- Contains technology stack, architecture patterns, and code conventions

**Architecture Decision Records**:

- Check `decisions/` for past architectural decisions and their rationale

**Developer guides**:

- Check `contributing/` for detailed implementation patterns and best practices

**Path-specific rules**:

- Check `.claude/rules/` for contextual rules that apply to specific file patterns
- Rules have `paths:` frontmatter specifying which files trigger them
- Include: `api.md`, `dal.md`, `security.md`, `testing.md`, `components.md`

**Available slash commands**:

- List all commands in `.claude/commands/` directory

**Available agents**:

- List all agents in `.claude/agents/` directory

**Available skills**:

- List all skills in `.claude/skills/` directory

**Hooks (automated behaviors)**:

- Check `.claude/settings.json` for configured hooks (via ClaudeKit)

### 2. External Research (When Needed)

**CRITICAL**: If the question involves Claude Code features, capabilities, or best practices NOT found in local documentation:

1. **Use the `claude-code-guide` agent** (preferred for Claude Code questions):

   ```
   Task(
     description="Lookup Claude Code [topic]",
     prompt="Find official documentation about [specific feature] in Claude Code. Focus on: usage patterns, best practices, and configuration options.",
     subagent_type="claude-code-guide"
   )
   ```

   The `claude-code-guide` agent has direct access to official Claude Code documentation and is the authoritative source for:
   - Claude Code CLI features (hooks, skills, slash commands, MCP servers, settings)
   - Claude Agent SDK (building custom agents)
   - Claude API and Anthropic SDK usage

2. **Use WebSearch** for broader research (non-Claude Code topics):
   - General programming patterns and best practices
   - Third-party library documentation
   - Industry standards and conventions

3. **Research triggers** - use `claude-code-guide` when:
   - Question asks about Claude Code features not in CLAUDE.md
   - Question mentions "skills", "hooks", "agents" architecture
   - Question asks "can Claude Code do X?" and local docs don't answer
   - Question involves recent Claude Code updates or changes
   - User asks about best practices for configuring Claude Code

### 3. Read Relevant Files

Based on the question, read the relevant documentation files to understand:

- What the harness README says about the component in question (`.claude/README.md`)
- What slash commands are available for this task
- What developer guides provide patterns for this
- What CLAUDE.md says about conventions
- What agents can assist with specialized tasks
- What skills are available for specialized capabilities
- What path-specific rules apply (if question relates to specific file types)

### 4. Identify the Best Approaches

Determine:

1. **Claude Code Method**: Is there a slash command, agent, or skill that can do this?
2. **Manual Method**: What's the step-by-step process to do it by hand?
3. **Process Exists?**: Is there a clearly defined process, or is this undocumented?

### 5. Handle Missing Processes

If NO clear process exists for the user's question:

1. **Acknowledge the gap**: Clearly state that there's no defined process for this yet
2. **Provide best-effort guidance**: Offer what you can based on similar patterns
3. **Offer appropriate next steps**: Based on the nature of the question

Use AskUserQuestion:

```
"I couldn't find a defined process for [topic]. How would you like to proceed?"
- Learn through experimentation first → I'll run `/system:learn`
- Create a defined process now → I'll run `/system:update`
- The guidance above is enough
```

**When to suggest each option:**

- `/system:learn` — When the user wants to "figure out how to" do something new, experiment with approaches, or discover capabilities
- `/system:update` — When the solution is known and just needs to be codified into the system

### 6. Provide the Answer

## Output Format

```markdown
## How to: [Task Description]

### Via Claude Code

**Option 1: Slash Command** (if applicable)
Use the command: `/command:name [arguments]`

Example:
```

/spec:create Add user authentication feature

```

**Option 2: Direct Prompt** (if no slash command)
Send this to Claude Code:
```

[Example prompt that accomplishes the task]

```

**Option 3: Agent** (if an agent helps)
Use the Task tool with the `[agent-name]` agent for this specialized task.

---

### Manual Method

1. **Open the file**: `[path/to/file]`
2. **Make the change**: [Step-by-step instructions]
3. **Verify**: [Any verification steps]

---

### Would you like me to:
- [ ] Execute the Claude Code method now?
- [ ] Show you more details about [specific aspect]?
```

### Output Format (No Process Found)

```markdown
## How to: [Task Description]

### Process Status: Not Defined

There's no clearly defined process for this in the repository yet.

### Best-Effort Guidance

Based on similar patterns, here's how you might approach this:

1. [Step 1]
2. [Step 2]
3. [Step 3]

### Create a Process?

Would you like me to create a defined process for this? This would:

- Add documentation to CLAUDE.md
- Create a slash command (if appropriate)
- Create a path-specific rule (if file-type specific)
- Establish a consistent workflow

**Options:**

- Yes, create a new process → I'll run `/system:update`
- No, the guidance above is enough
```

## Common Question Mappings

Reference these when answering:

| Question Pattern         | Claude Code                         | Manual                                                              |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------- |
| "create a spec"          | `/spec:create [description]`        | Create file in `specs/`                                             |
| "ideate a feature"       | `/ideate [task-brief]`              | Create ideation document                                            |
| "commit changes"         | `/git:commit`                       | Use git commands                                                    |
| "push to remote"         | `/git:push`                         | `git push`                                                          |
| "create a branch"        | Direct prompt: "Create branch X"    | `git checkout -b`                                                   |
| "run database migration" | `/db:migrate`                       | `pnpm prisma migrate deploy`                                        |
| "scaffold a feature"     | Direct prompt: "Create feature X"   | Create FSD directory structure per `contributing/project-structure.md` |
| "review recent work"     | `/review-recent-work`               | Manual code inspection                                              |
| "manage roadmap"         | `/roadmap [subcommand]`             | Edit `roadmap/roadmap.json`                                         |
| "git status"             | Direct prompt: "Show git status"    | `git status && git diff`                                            |
| "learn how to X"         | `/system:learn [topic]`             | Research, experiment, document manually                             |
| "codify what worked"     | `/system:learn we successfully [X]` | Create skill/command manually                                       |
| "create an ADR"          | `/adr:create [title]`               | Create `decisions/NNNN-slug.md` manually                            |
| "list ADRs"              | `/adr:list`                         | Read `decisions/manifest.json`                                      |
| "extract ADRs from spec" | `/adr:from-spec [slug]`             | Review spec and draft ADRs manually                                 |
| "why did we choose X?"   | Check `decisions/` + `/adr:list`    | Read relevant ADR files                                             |

## Claude Code Architecture Notes

When explaining processes, clarify the invocation model:

**Slash Commands (User-Invoked):**

- User explicitly types `/command` to trigger them
- Example: `/spec:create`, `/git:commit`, `/roadmap`
- Use when: User wants explicit control over execution
- Location: `.claude/commands/[namespace]/[name].md`

**Agents (Tool-Invoked):**

- Invoked via Task tool for complex isolated workflows
- Have separate context windows (prevents context pollution)
- Example: `typescript-expert`, `database-expert`, `react-expert`
- Use when: Complex multi-step task needs isolation or specialized expertise
- Location: `.claude/agents/[category]/[name].md`
- Cannot spawn other agents (prevents infinite nesting)

**Skills (Model-Invoked):**

- Reusable expertise packages that Claude applies automatically when relevant
- Can be project-local (`.claude/skills/`) or external plugins
- Invoked automatically by Claude based on context matching
- Example: `reviewing-code` for code review expertise, `designing-frontend` for UI generation
- Use when: Content teaches reusable expertise that should apply automatically
- Discover available skills via the Skill tool's available_skills list

**Hooks (Event-Triggered):**

- Automatically run at lifecycle events via ClaudeKit
- Configured in `.claude/settings.json`
- Events: SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop
- Use when: Behavior must happen at specific points

**Path-Specific Rules (Path-Triggered):**

- Automatically loaded when Claude works with matching files
- Located in `.claude/rules/*.md` with `paths:` YAML frontmatter
- Example: `api.md` with `paths: apps/server/src/routes/**/*.ts`
- Use when: Guidelines apply only to specific file types/paths
- Location: `.claude/rules/[topic].md`

### Choosing Between Agents and Skills

| Criteria          | Use Agent                              | Use Skill                     |
| ----------------- | -------------------------------------- | ----------------------------- |
| **Scope**         | Project-specific complex task          | Domain-wide capability        |
| **Context**       | Needs isolation/separate context       | Operates in main conversation |
| **Customization** | Highly customizable per project        | Standardized behavior         |
| **Definition**    | Local `.md` file in `.claude/agents/`  | External plugin               |
| **Examples**      | `database-expert`, `typescript-expert` | `designing-frontend`          |

**Key Distinction:**

- **Agents** = Custom project experts defined locally, run in isolated context
- **Skills** = Packaged domain capabilities (plugins), run in main conversation

### When Explaining Processes

- **For Commands**: Explain they're user-triggered with `/cmd`
- **For Agents**: Mention they're spawned via Task tool for isolated execution
- **For Skills**: Explain they're invoked via Skill tool for domain expertise
- **For Hooks**: Explain which lifecycle event triggers them
- **For Rules**: Explain which file patterns trigger them and what guidance they provide

## Important Notes

- Always check CLAUDE.md first - it's the authoritative source for project conventions
- Developer guides in `contributing/` contain detailed patterns
- If a slash command exists, prefer that over a raw prompt
- For database schema changes, remind users about the migration-first workflow
- For code changes, remind about the prohibition on `any` types
