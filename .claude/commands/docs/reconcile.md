---
description: Check developer guides for documentation drift against recent code changes
argument-hint: '[guide-name | --commit <sha> | --since <timeframe> | --all]'
allowed-tools: Read, Grep, Glob, Bash, Task, AskUserQuestion, TodoWrite
category: documentation
---

# Documentation Reconciliation

Check if developer guides are in sync with the codebase by analyzing recent commits against guide coverage areas.

## Arguments

Parse `$ARGUMENTS` to determine the mode:

| Argument              | Mode                | Description                                                               |
| --------------------- | ------------------- | ------------------------------------------------------------------------- |
| `<guide-name>`        | Single guide        | Check one specific guide (e.g., `data-fetching.md`)                       |
| `--commit <sha>`      | Commit review       | Analyze a specific commit for documentation impact                        |
| `--since <timeframe>` | Time range          | Check commits within a timeframe (e.g., `1 week`, `3 days`, `2024-12-01`) |
| `--all`               | Full reconciliation | Check all guides against their last-reviewed dates                        |
| _(no args)_           | Smart mode          | Check guides touched by uncommitted changes + commits since last session  |

**Examples:**

```bash
/docs:reconcile data-fetching.md               # Check specific guide
/docs:reconcile --commit abc123                # Analyze one commit
/docs:reconcile --since "1 week"               # Last week's commits
/docs:reconcile --since "2024-12-15"           # Since specific date
/docs:reconcile --all                          # Full reconciliation
/docs:reconcile                                # Smart mode (recommended)
```

## Order of Operations

### Phase 1: Parse Arguments and Determine Mode

```bash
MODE="smart"  # Default
TARGET=""

if [ -z "$ARGUMENTS" ]; then
  MODE="smart"
elif [[ "$ARGUMENTS" == "--all" ]]; then
  MODE="all"
elif [[ "$ARGUMENTS" == --commit* ]]; then
  MODE="commit"
  TARGET=$(echo "$ARGUMENTS" | sed 's/--commit //')
elif [[ "$ARGUMENTS" == --since* ]]; then
  MODE="since"
  TARGET=$(echo "$ARGUMENTS" | sed 's/--since //')
elif [[ "$ARGUMENTS" =~ \.md$ ]]; then
  MODE="guide"
  TARGET="$ARGUMENTS"
else
  # Assume it's a guide name without .md
  MODE="guide"
  TARGET="$ARGUMENTS.md"
fi
```

### Phase 2: Load Guide Mapping

Read `contributing/INDEX.md` to get:

- Pattern-to-guide mappings
- Last reviewed dates
- Guide descriptions

```bash
# Read the INDEX.md file
INDEX_FILE="contributing/INDEX.md"

# Extract guide info into structured data
# Parse the YAML section for pattern mappings
# Parse the Maintenance Tracking table for last-reviewed dates
```

### Phase 3: Gather Commits Based on Mode

**Smart Mode (no args):**

1. Get uncommitted changes: `git diff --name-only HEAD`
2. Get commits from today: `git log --since="midnight" --oneline`
3. If no commits today, get last 5 commits: `git log -5 --oneline`

**All Mode (--all):**

1. For each guide, get last-reviewed date from INDEX.md
2. Get commits since that date: `git log --since="<date>" --oneline`

**Commit Mode (--commit <sha>):**

1. Get files changed in that commit: `git show --name-only --format="" <sha>`

**Since Mode (--since <timeframe>):**

1. Parse timeframe (supports: "X days", "X weeks", "YYYY-MM-DD")
2. Get commits: `git log --since="<timeframe>" --oneline`

**Guide Mode (<guide-name>):**

1. Get last-reviewed date for that guide from INDEX.md
2. Get commits since that date
3. Filter to commits touching files matching guide patterns

### Phase 4: Map Changes to Guides

For each commit/change gathered:

1. Get files changed
2. Match files against guide patterns (from INDEX.md)
3. Build a map: `{ guide -> [list of relevant commits/changes] }`

```bash
# Pattern matching logic (from INDEX.md patterns)
declare -A GUIDE_PATTERNS=(
  ["project-structure.md"]="apps/client/src/layers/|apps/server/src/|packages/"
  ["architecture.md"]="transport.ts|direct-transport|http-transport|apps/obsidian-plugin/build-plugins"
  ["design-system.md"]="apps/client/src/index.css|apps/client/src/layers/shared/ui/"
  ["api-reference.md"]="openapi-registry|apps/server/src/routes/|packages/shared/src/schemas"
  ["configuration.md"]="config-manager|config-schema|packages/cli/"
  ["interactive-tools.md"]="interactive-handlers|apps/client/src/layers/features/chat/"
  ["keyboard-shortcuts.md"]="use-interactive-shortcuts"
  ["obsidian-plugin-development.md"]="apps/obsidian-plugin/"
  ["data-fetching.md"]="apps/server/src/routes/|apps/client/src/layers/entities/|apps/client/src/layers/features/chat/"
  ["state-management.md"]="app-store|apps/client/src/layers/entities/|apps/client/src/layers/shared/model/"
  ["animations.md"]="animation|motion|apps/client/src/index.css"
  ["styling-theming.md"]="index.css|apps/client/src/layers/shared/ui/|tailwind"
  ["parallel-execution.md"]=".claude/agents/|\.claude/commands/"
  ["autonomous-roadmap-execution.md"]=".claude/commands/roadmap/"

  # External docs (MDX) — from contributing/INDEX.md External Docs Coverage table
  ["docs/getting-started/configuration.mdx"]="config-manager|config-schema|packages/cli/"
  ["docs/integrations/sse-protocol.mdx"]="apps/server/src/routes/sessions|stream-adapter|session-broadcaster"
  ["docs/integrations/building-integrations.mdx"]="transport.ts|direct-transport|http-transport"
  ["docs/self-hosting/deployment.mdx"]="packages/cli/|config-manager"
  ["docs/self-hosting/reverse-proxy.mdx"]="apps/server/src/routes/sessions|stream-adapter"
  ["docs/contributing/architecture.mdx"]="apps/server/src/services/|transport.ts|apps/obsidian-plugin/"
  ["docs/contributing/testing.mdx"]="packages/test-utils/|vitest"
  ["docs/contributing/development-setup.mdx"]="package.json|turbo.json|apps/"
  ["docs/guides/cli-usage.mdx"]="packages/cli/"
  ["docs/guides/tunnel-setup.mdx"]="tunnel-manager"
  ["docs/guides/slash-commands.mdx"]="command-registry|.claude/commands/"
)

# For each file, find matching guides
match_file_to_guides() {
  local file="$1"
  local matching_guides=()

  for guide in "${!GUIDE_PATTERNS[@]}"; do
    patterns="${GUIDE_PATTERNS[$guide]}"
    for pattern in $(echo "$patterns" | tr '|' ' '); do
      if echo "$file" | grep -qE "$pattern"; then
        matching_guides+=("$guide")
        break
      fi
    done
  done

  echo "${matching_guides[@]}"
}
```

### Phase 5: Analyze Impact

For each affected guide, analyze the commits to determine:

1. **Change severity**: How significant are the changes?
   - Schema changes, new patterns → High
   - Minor tweaks, bug fixes → Low

2. **Documentation relevance**: Does the change introduce something the guide should cover?
   - New API patterns
   - Changed conventions
   - New dependencies

3. **Staleness score**: How long since the guide was reviewed vs. how many changes occurred?

### Phase 6: Present Findings

Display a summary organized by priority:

```
═══════════════════════════════════════════════════════════════
                DOCUMENTATION RECONCILIATION
═══════════════════════════════════════════════════════════════

Mode: [smart | all | commit | since | guide]
Scope: [description of what was analyzed]
Period: [date range if applicable]

───────────────────────────────────────────────────────────────
                    POTENTIALLY AFFECTED GUIDES
───────────────────────────────────────────────────────────────

🔴 HIGH PRIORITY (likely needs updates)

  data-fetching.md
  Last reviewed: 2024-12-01
  Relevant changes: 5 commits

  Commits:
  • abc1234 - Add new entity hook for file listing
  • def5678 - Update Transport interface with new method
  • ghi9012 - Change SSE event handling approach

  Potentially affected sections:
  • Entity hooks (new data fetching hook)
  • Transport interface (new method added)
  • SSE streaming (event handling changed)

───────────────────────────────────────────────────────────────

🟡 MEDIUM PRIORITY (may need review)

  state-management.md
  Last reviewed: 2024-12-15
  Relevant changes: 2 commits

  Commits:
  • jkl3456 - Add new Zustand store slice
  • mno7890 - Update URL state parameter handling

───────────────────────────────────────────────────────────────

🟢 LOW PRIORITY (minor changes)

  styling-theming.md
  Last reviewed: 2024-12-20
  Relevant changes: 1 commit

  Commits:
  • pqr1234 - Fix button hover state

───────────────────────────────────────────────────────────────

✅ UP TO DATE (no relevant changes)

  01-project-structure.md - No changes since last review
  02-environment-variables.md - No changes since last review
  ...

═══════════════════════════════════════════════════════════════
```

### Phase 7: Offer Actions

Use AskUserQuestion to offer next steps:

```
AskUserQuestion:
- question: "How would you like to proceed?"
- header: "Action"
- multiSelect: true
- options:
  1. label: "Review high-priority guides"
     description: "I'll analyze each high-priority guide in detail and suggest specific updates"

  2. label: "Update INDEX.md dates"
     description: "Mark reviewed guides as up-to-date (update last_reviewed dates)"

  3. label: "Run /spec:doc-update"
     description: "Launch full documentation review workflow for a specific spec"

  4. label: "Done for now"
     description: "I've noted the findings, will address later"
```

### Phase 8: Execute Selected Actions

**If "Review high-priority guides" selected:**

For each high-priority guide:

1. Read the full guide content
2. Read the relevant commit diffs
3. Analyze what's documented vs. what's in code
4. Present specific suggestions:

````
═══════════════════════════════════════════════════════════════
            DETAILED REVIEW: data-fetching.md
═══════════════════════════════════════════════════════════════

## Section: Entity Hooks (line 34-60)

Current documentation:
  "Entity hooks wrap TanStack Query with Transport calls..."

Code shows:
  Commit abc1234 added a new useFiles entity hook
  with staleTime and file path filtering

🔧 SUGGESTED UPDATE:
  Add useFiles to the entity hooks section:

  ### File Entity Hook

  The file browser uses a dedicated entity hook:

  ```typescript
  export function useFiles(dir: string) {
    const transport = useTransport();
    return useQuery({
      queryKey: ['files', dir],
      queryFn: () => transport.listFiles(dir),
    });
  }
````

───────────────────────────────────────────────────────────────

Would you like me to apply this update? [Yes / No / Modify first]

````

**If "Update INDEX.md dates" selected:**

Update the Maintenance Tracking table in INDEX.md:

```bash
# For each guide marked as reviewed
sed -i '' "s/| $GUIDE |.*|/| $GUIDE | $(date +%Y-%m-%d) | Claude | Reconciled via /docs:reconcile |/" contributing/INDEX.md
````

## Smart Mode Algorithm

When run without arguments, smart mode uses this logic:

```
1. Check for uncommitted changes
   - If yes: Analyze those files
   - Map to affected guides

2. Check for commits since session start (or last 24 hours)
   - If yes: Analyze those commits
   - Map to affected guides

3. Combine findings
   - Deduplicate guides
   - Order by relevance

4. If no changes found:
   - Fall back to checking guides not reviewed in 30+ days
   - Report staleness
```

## Commit Analysis

When analyzing a specific commit:

```bash
# Get commit details
git show $COMMIT --stat

# Get commit message (often describes intent)
git log -1 --format="%B" $COMMIT

# Get changed files
git show --name-only --format="" $COMMIT

# Get diff for detailed analysis
git show $COMMIT
```

For significant commits, extract:

- What changed (from diff)
- Why it changed (from commit message)
- Whether it introduces new patterns
- Whether it deprecates old approaches

## Integration with Other Commands

- **/spec:execute** — Calls this command's logic at completion
- **/spec:doc-update** — More comprehensive, spec-focused review
- **/system:review** — Includes guides in overall harness review

## Edge Cases

- **No commits found**: Report "No changes to analyze" with suggestion to use `--since`
- **Guide not found**: List available guides and ask user to choose
- **Invalid commit SHA**: Report error with suggestion to check `git log`
- **Git not available**: Report error, suggest checking git installation
- **INDEX.md missing**: Create it by running the setup or reporting error

## Output Modes

The command adjusts verbosity based on findings:

- **Many changes**: Grouped summary, ask before details
- **Few changes**: Show all details inline
- **No changes**: Brief confirmation, suggest next review date
