---
title: 'Agent Creation & Workspace Templates — Deep Dive Research'
date: 2026-03-23
type: implementation
status: active
tags:
  [
    agent-creation,
    giget,
    onboarding,
    personality-sliders,
    AGENTS.md,
    DorkBot,
    mkdir-security,
    path-traversal,
    crossfade-animation,
    workspace-templates,
  ]
feature_slug: agent-creation-and-templates
searches_performed: 14
sources_count: 28
---

## Research Summary

This report fills the specific gaps in the Agent Creation & Workspace Templates brief (Spec #168). Four areas were investigated: giget's practical error handling and edge cases; onboarding personality slider animation patterns with live text crossfade; default agent AGENTS.md content architecture; and filesystem security for the `mkdir` pipeline. Critically, most foundational questions are already answered in prior research — this report builds on those findings without repeating them.

Prior research consulted:

- `research/20260323_agent_workspace_starter_templates.md` — giget basics, template catalog (authoritative on fundamentals)
- `research/20260321_agent_personality_convention_files_impl.md` — SOUL.md/trait rendering, personality systems (authoritative)
- `research/20260301_ftue_best_practices_deep_dive.md` — onboarding philosophy (authoritative)
- `research/20260216_directory_boundary_sandbox.md` — path traversal security (authoritative)
- `research/20260322_agents_page_fleet_management_ux_deep_dive.md` — agents page UX

---

## Key Findings

### 1. giget Error Handling — The Library Has No Formal Error Taxonomy

giget does not expose a typed error hierarchy. Error handling requires wrapping every `downloadTemplate()` call in try/catch and inspecting the thrown Error's `message` string. GitHub Issue #194 explicitly documents user frustration at the generic "Failed to fetch" error — the maintainers have not addressed this. DorkOS must implement its own error classification layer on top.

**What actually throws:**

- Network failure: throws a generic `Error` with message containing "Failed to fetch" or "fetch failed"
- 404 (repo not found): throws with a message that includes the HTTP status code
- 401 (auth failure): throws with a message containing "401" or "Unauthorized"
- Directory exists (without `force`): throws with a message about existing directory
- Disk space / write failure: Node.js `ENOSPC` or `EACCES` via the underlying `fs.writeFile`

**There is no `onProgress` callback in giget.** The `downloadTemplate()` function downloads a tarball and extracts it — this is a single async operation with no intermediate progress events. The tarball is fetched via `node-fetch-native`, and giget does not expose streaming or progress reporting. For typical templates (5–50MB), this is fast enough (~2–5 seconds) that a spinner without progress percentage is acceptable.

**There is no cancellation support.** Once `downloadTemplate()` is called, it cannot be aborted. The `AbortController` pattern would require forking the library or using `giget-core` (a slimmer fork). For DorkOS v1, this is acceptable — show a spinner and disable the Cancel button during download.

**Authentication fallback chain** (resolved from the brief's decision):

1. `auth` option in `downloadTemplate()` options
2. `GIGET_AUTH` environment variable (automatically used by giget)
3. For GitHub-specific fallback: `gh auth token` CLI command (requires GitHub CLI to be installed)

The fallback to `gh auth token` must be implemented by DorkOS explicitly — giget only reads `GIGET_AUTH`. The server should attempt `execSync('gh auth token', { stdio: ['pipe', 'pipe', 'pipe'] })` silently; if it fails (CLI not installed, not logged in), proceed without auth.

### 2. Onboarding Personality Animation — Static Template Swap with AnimatePresence

The brief's decision (Resolved Decision #6) specifies "static templates for each slider level" — this is the correct approach and aligns with what the research confirms. The animation question is: how do you make the text swap feel alive rather than abrupt?

**The answer: `AnimatePresence mode="wait"` with `key` on the text content.**

When `key` changes on a child of `AnimatePresence`, the old element exits before the new one enters. With `mode="wait"`, the incoming element waits for the outgoing element to finish its exit animation. For text, this creates a clean crossfade.

```typescript
// Crossfade text preview on slider change
const previewText = getPreviewText(traits); // lookup from static table

<AnimatePresence mode="wait" initial={false}>
  <motion.p
    key={previewText} // key change triggers exit/enter cycle
    initial={{ opacity: 0, y: 4 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: -4 }}
    transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
    className="text-sm text-foreground"
  >
    {previewText}
  </motion.p>
</AnimatePresence>
```

The `y: 4` on enter and `y: -4` on exit creates a subtle upward "scroll" that reads as the text updating, not just blinking. This is the same pattern used by Linear's status change animations and Vercel's deployment status transitions.

**Slider debouncing:** The preview should not re-trigger on every pixel of slider movement. Use `useDeferredValue` (React 19) or a 100ms debounce to ensure the animation only fires when the user pauses on a position. Rapid scrubbing through slider values would create a jarring animation cascade.

```typescript
const deferredTraits = useDeferredValue(traits);
const previewText = getPreviewText(deferredTraits);
```

**The bubble container animation:** The speech bubble should have a subtle `scale` and `boxShadow` transition when traits change — not a full re-render, just a pulse that says "I'm reacting":

```typescript
<motion.div
  animate={{
    scale: isChanging ? 1.02 : 1,
    boxShadow: isChanging
      ? '0 4px 24px rgba(0,0,0,0.12)'
      : '0 2px 8px rgba(0,0,0,0.06)',
  }}
  transition={{ duration: 0.15 }}
  className="rounded-2xl border bg-card p-4"
>
  {/* AnimatePresence text inside */}
</motion.div>
```

`isChanging` is derived from whether the current traits differ from the last "settled" value after debounce.

**DorkBot avatar ambient animation:** The brief specifies "gentle breathing/pulsing that intensifies slightly as sliders are adjusted." This is best implemented as a CSS animation (compositor thread, no JS overhead) with a JS-driven intensity multiplier:

```css
@keyframes dorkbotBreath {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.03);
  }
}
.dorkbot-avatar {
  animation: dorkbotBreath 3s ease-in-out infinite;
}
.dorkbot-avatar.reacting {
  animation-duration: 0.8s; /* faster breathing when being adjusted */
}
```

Toggle the `reacting` class when the user is actively dragging a slider.

### 3. DorkBot AGENTS.md — Authoritative Content Architecture

Anthropic's own Claude Code best practices documentation (as of March 2026) establishes the canonical AGENTS.md guidelines:

**What to include:**

- Bash commands Claude can't guess (non-obvious run/build/test commands)
- Code style rules that differ from language defaults
- Architecture decisions specific to the project
- Non-obvious behaviors, gotchas, required env vars
- Links to supplementary docs (via `@path/to/file` imports)

**What to exclude:**

- Standard language conventions the agent already knows
- Detailed API documentation (link instead)
- File-by-file descriptions of the codebase
- Self-evident practices ("write clean code")
- Any instruction that doesn't apply broadly to all tasks

**Token budget constraint:** The recommended length is under 300 lines, with the most effective AGENTS.md files being under 60 lines. Claude Code already has ~50 instructions in its system prompt, leaving limited capacity before the model starts deprioritizing AGENTS.md content. **Critical insight: a bloated AGENTS.md causes the model to ignore it entirely.** Quality and brevity over comprehensiveness.

**For DorkBot specifically:** The brief specifies "comprehensive product knowledge baked in." The research confirms this is correct but the implementation must be disciplined. DorkBot's AGENTS.md should use the `@path` import pattern to organize knowledge into supplementary files rather than embedding it all inline:

```markdown
# DorkBot

You are DorkBot, a general-purpose AI agent running inside DorkOS — the operating
system for autonomous AI agents. DorkOS gives you tools for scheduling, messaging
between agents, and discovery across projects.

## What you can do

- **Chat**: Answer questions, write code, run tasks in this workspace
- **Pulse**: Schedule recurring tasks via the DorkOS scheduling system
- **Relay**: Send and receive messages between agents
- **Mesh**: Discover other agents registered across projects

## Key commands

See @.dork/docs/dorkos-commands.md for the commands you can run.

## DorkOS concepts

See @.dork/docs/dorkos-concepts.md for documentation on subsystems, terminology,
and common workflows.

## Agent rules

- Always run tests before marking a task complete
- For questions about DorkOS, check the documentation before guessing
- When uncertain about a system operation, prefer asking over acting
```

The supplementary files (`dorkos-commands.md`, `dorkos-concepts.md`) contain the actual detailed content and are loaded on demand when Claude needs them, not on every message. This keeps the base AGENTS.md under 25 lines while still giving DorkBot access to comprehensive knowledge.

**Important:** The `@path` import syntax is a Claude Code feature. It only works when Claude Code is the runtime. For multi-runtime compatibility, the inline version of the AGENTS.md (without `@` imports) should be the fallback.

**Tone of DorkBot's AGENTS.md:** It should speak to the agent about its role, not describe the agent to a human reader. "You are DorkBot" not "DorkBot is a general-purpose agent." The agent reads this at the start of every session — it should feel like a self-description, not a specification.

### 4. Filesystem Security for mkdir — Confirmed and Extended

The existing `research/20260216_directory_boundary_sandbox.md` is the authoritative source. This research extends it specifically for the `POST /api/directory` (mkdir) endpoint and the agent creation pipeline.

**Critical additions beyond the prior research:**

**Kebab-case validation must happen before path resolution.** The agent name input (which becomes the directory name) should be validated against a strict regex _before_ any filesystem operations:

```typescript
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$/;

function validateAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      'Agent name must be lowercase letters, numbers, and hyphens only. Must start with a letter.',
      'INVALID_AGENT_NAME'
    );
  }
  if (name.includes('--')) {
    throw new ValidationError(
      'Agent name cannot contain consecutive hyphens.',
      'INVALID_AGENT_NAME'
    );
  }
}
```

This is a defense-in-depth measure. Even after passing this regex, the path is still fully resolved and boundary-checked via `PathValidator`. The regex prevents names like `../escape` from ever reaching the filesystem layer.

**Reserved names to reject:**

- `.dork` (conflicts with DorkOS metadata directory)
- `dorkbot` (reserved for the default agent — if it already exists, return a clear conflict error)
- Names matching existing agent directories in the target root
- Extremely short names (single character) are technically valid kebab-case but semantically poor — consider a minimum of 2 characters

**The `fs.mkdir` call must use `{ recursive: false }` for user-specified names.** Specifically, the final target directory (`~/.dork/agents/{name}`) must NOT use recursive creation. If the directory already exists, Node.js throws `EEXIST`. This is the 409 Conflict path. Using `recursive: true` would silently succeed on an existing directory, masking the collision.

The only path that should use `recursive: true` is creating the base agents directory (`~/.dork/agents/`) itself, which may not exist on first use.

```typescript
// Create the agents root (idempotent — OK if it exists)
await fs.mkdir(agentsRoot, { recursive: true });

// Create the individual agent directory (must NOT exist)
try {
  await fs.mkdir(agentDir, { recursive: false });
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
    throw new ConflictError(`Agent directory already exists: ${agentDir}`, 'DIRECTORY_EXISTS');
  }
  throw err;
}
```

**TOCTOU for templates:** When downloading a template to an agent directory, there is a race condition: the directory is created (empty), then the template is downloaded. If another process creates files in the directory between those two operations, giget's `force: false` may throw unexpectedly. The mitigation is to mark the directory as "in progress" immediately by writing a `.dork/.creating` sentinel file, and removing it on successful scaffold completion. The agent registration step should check for this sentinel and skip stale directories (those that are in-progress but older than 5 minutes).

**Permission errors on macOS:** The most common permission error is when `~/.dork/` itself doesn't exist and the first `mkdir` fails because the user's home directory has restricted permissions on a managed macOS machine. DorkOS should check that `~/.dork/` is writable at startup (same as the existing dork-home.ts validation) and provide a clear error message if not.

---

## Detailed Analysis

### giget: Practical Error Wrapping Pattern

The correct server-side wrapper for `downloadTemplate()` in the agent creation pipeline:

```typescript
import { downloadTemplate } from 'giget';

export async function downloadAgentTemplate(
  source: string,
  targetDir: string,
  auth?: string
): Promise<{ dir: string; source: string }> {
  try {
    const result = await downloadTemplate(source, {
      dir: targetDir,
      force: false,
      auth,
    });
    return result;
  } catch (err) {
    const message = (err as Error).message ?? '';

    if (message.includes('Failed to fetch') || message.includes('fetch failed')) {
      throw new TemplateDownloadError(
        `Could not reach the template repository. Check your internet connection.`,
        'NETWORK_ERROR',
        { source }
      );
    }
    if (message.includes('401') || message.includes('Unauthorized') || message.includes('403')) {
      throw new TemplateDownloadError(
        `Authentication failed. Set GITHUB_TOKEN or run \`gh auth login\` to access private templates.`,
        'AUTH_ERROR',
        { source }
      );
    }
    if (message.includes('404') || message.includes('Not Found')) {
      throw new TemplateDownloadError(
        `Template not found: ${source}. Check the repository URL and your access permissions.`,
        'NOT_FOUND',
        { source }
      );
    }
    if (message.includes('already exists') || (err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new TemplateDownloadError(
        `Target directory already has content. Use force:true to overwrite.`,
        'DIRECTORY_EXISTS',
        { source }
      );
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new TemplateDownloadError(
        `Insufficient disk space to download template.`,
        'DISK_FULL',
        { source }
      );
    }
    // Unknown error — re-throw with context
    throw new TemplateDownloadError(`Template download failed: ${message}`, 'UNKNOWN', {
      source,
      originalError: message,
    });
  }
}
```

**Auth token resolution chain:**

```typescript
export async function resolveGitHubToken(): Promise<string | undefined> {
  // 1. Explicit env var (highest priority)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GIGET_AUTH) return process.env.GIGET_AUTH;

  // 2. GitHub CLI (if available)
  try {
    const { execSync } = await import('child_process');
    const token = execSync('gh auth token', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    })
      .toString()
      .trim();
    if (token) return token;
  } catch {
    // gh not installed or not logged in — not an error
  }

  return undefined;
}
```

**Progress indication without callbacks:** Since giget has no progress events, use a loading state pattern that communicates stages rather than percentage:

```typescript
// Server SSE progress events for the client
type TemplateDownloadStage =
  | 'validating' // Checking template source and auth
  | 'downloading' // Fetching tarball (no progress, just spinner)
  | 'extracting' // Writing files to disk
  | 'scaffolding' // Writing agent.json, SOUL.md, NOPE.md
  | 'complete'
  | 'error';
```

The client shows: "Downloading template..." with a spinner during the `downloading` stage (which is where the actual time is spent). This is honest — no fake progress bars.

### Onboarding UX: The "DorkBot Comes Alive" Transition

The brief's most ambitious requirement is the transition from onboarding to first chat: "the personality preview bubble smoothly transforms into the first message in a real chat session."

This requires `layoutId` — Motion's shared element transition system:

```typescript
// In the onboarding step
<motion.div layoutId="dorkbot-bubble" className="rounded-2xl bg-card p-4">
  <AnimatePresence mode="wait">
    <motion.p key={previewText} ...>{previewText}</motion.p>
  </AnimatePresence>
</motion.div>

// In the chat session (first message from DorkBot)
<motion.div layoutId="dorkbot-bubble" className="chat-message-bubble">
  <p>{firstChatMessage}</p>
</motion.div>
```

When the user clicks "Create DorkBot" and the UI transitions from the onboarding screen to the chat view, Motion will animate the bubble from its onboarding position to its chat position, morphing the corners, size, and position in a single fluid motion. The text inside it will also transition.

**Important caveat:** `layoutId` animations require both elements to be in the React tree simultaneously during the transition (even briefly). The implementation must ensure the chat session component mounts with the bubble _before_ the onboarding component unmounts. A `LayoutGroup` wrapper over the entire onboarding flow and chat view enables this.

**Fallback for accessibility:** The `layoutId` transition respects `prefers-reduced-motion`. When the reduced motion preference is set, Motion skips layout animations entirely — the transition becomes an instant swap. This is correct behavior.

**The transition timeline:**

1. User clicks "Create DorkBot"
2. Loading state begins (spinner on button, 200–800ms for API call)
3. On success: animate bubble from center of screen to top-left chat position (Motion `layoutId`, 400ms)
4. Chat session renders; DorkBot's first message appears with a typing indicator, then the message text
5. Onboarding overlay fades out (opacity 0, 200ms, after the bubble has moved)

The first DorkBot message in chat is the personality-appropriate greeting from the static template lookup table — the same content the user saw in the preview, but now in the chat UI and framed as a real response.

### DorkBot AGENTS.md: Token-Efficient Knowledge Architecture

The `@path` import pattern enables a clean separation:

**`AGENTS.md` (top-level, ~25 lines, always loaded):**

```markdown
# DorkBot

You are DorkBot, the default AI agent for DorkOS — the coordination layer for
autonomous agents. DorkOS manages scheduling (Pulse), messaging (Relay), and
agent discovery (Mesh). You are a general-purpose agent that runs in
`~/.dork/agents/dorkbot/`.

## Your capabilities

Answer questions about DorkOS, write and run code, help with projects,
or run ad-hoc tasks. You have access to the full Claude Code toolset.

## DorkOS documentation

- Architecture and subsystems: @.dork/docs/dorkos-overview.md
- Common commands: @.dork/docs/commands.md
- How to help with DorkOS configuration: @.dork/docs/configuration.md

## Behavior rules

- Be concise unless asked for detail. One-screen answers preferred.
- For DorkOS questions, reference the docs above before speculating.
- When starting tasks in a new directory, always check for AGENTS.md first.
```

**`.dork/docs/dorkos-overview.md` (~100 lines, loaded on demand):**
Contains explanations of Pulse, Relay, Mesh, the agent model, session concepts, etc.

**`.dork/docs/commands.md` (~50 lines, loaded on demand):**
Contains `pnpm dev`, `pnpm test`, etc. — but scoped to generic DorkOS server commands that DorkBot would actually use when helping someone with DorkOS itself. (DorkBot may need to start the dev server, run tests, etc. when helping with DorkOS development.)

**`.dork/docs/configuration.md` (~80 lines, loaded on demand):**
Documents env vars, feature flags, port configuration, etc.

This architecture gives DorkBot access to ~250 lines of rich context but only loads them when relevant. The base AGENTS.md stays under 25 lines — well within the "under 60 lines" best practice from HumanLayer's research.

**The key content decision:** DorkBot's AGENTS.md must tell the agent _what DorkOS is_ (the context it needs to answer questions) and _where to find more details_ (the supplementary docs). It should NOT try to document every DorkOS feature inline — that's what the docs files are for.

---

## Potential Solutions / Approaches

### Area 1: giget Error Handling

**Option A: String message inspection (recommended for v1)**

- Description: Wrap `downloadTemplate()` in a catch block and classify errors by inspecting the error message string.
- Pros: Works today, no library changes needed, handles all known error cases.
- Cons: Fragile — giget maintainers could change error messages without warning. Needs a test suite to catch regressions.
- Complexity: Low
- Maintenance: Low-medium (monitor giget releases for error message changes)

**Option B: fork giget / use giget-core**

- Description: Fork `@bluwy/giget-core` and add typed error classes and progress callbacks.
- Pros: Full control, proper error taxonomy, could add progress events.
- Cons: Maintenance burden of a fork, giget-core is already a simplified fork without registry support.
- Complexity: High
- Maintenance: High (must rebase on upstream changes)

**Recommendation: Option A.** The error cases are well-understood (network, auth, 404, disk) and the message inspection approach covers them all. Write tests that mock the underlying fetch to ensure each error path is exercised.

---

### Area 2: Personality Slider Live Preview

**Option A: Static lookup table + `AnimatePresence mode="wait"` (recommended)**

- Description: 5 levels × 5 dimensions = 25 pre-written preview strings. Slider change triggers `key` swap on the preview text element.
- Pros: Instant feedback, zero API calls, deterministic, testable. Already decided in the brief.
- Cons: 25 strings to write and maintain. Level 3 "balanced" texts must feel coherent across dimensions.
- Complexity: Low
- Maintenance: Low (edit strings in a constants file when copy needs updating)

**Option B: LLM-generated preview on slider change**

- Description: Call an LLM to generate personality-appropriate text on each slider move.
- Pros: More natural, can combine multiple slider values into coherent text.
- Cons: Latency (300–1000ms per change), API cost, non-deterministic, non-auditable, requires API key configured before DorkBot even exists.
- Complexity: High
- Maintenance: High

**Recommendation: Option A.** The brief has already resolved this correctly. The 25-string lookup table is the right implementation.

**Additional implementation detail — the preview string table:**

The strings for the 5 traits should be written from DorkBot's first-person perspective as a greeting/self-introduction. This is what will feel "alive" during onboarding:

| Tone    | Level 1 (Serious)                                | Level 3 (Balanced)                              | Level 5 (Playful)                                              |
| ------- | ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------- |
| Preview | "Ready to assist with precision and efficiency." | "Hey — I'm DorkBot. Let me know what you need." | "LET'S. GO. I'm DorkBot and I'm unreasonably excited to help!" |

The brief already has the right examples. The full table needs 25 strings that feel natural and distinct at each level.

---

### Area 3: Default Agent AGENTS.md

**Option A: Inline monolithic AGENTS.md (~150 lines)**

- Description: All DorkBot knowledge in a single file, no imports.
- Pros: Works with any runtime (no `@path` imports needed), self-contained, no supplementary files to maintain.
- Cons: 150 lines is above the recommended threshold; model may begin to deprioritize rules as the file grows.
- Complexity: Low
- Maintenance: Medium (single file to update when DorkOS changes)

**Option B: Compact AGENTS.md with `@path` imports (recommended)**

- Description: Base AGENTS.md stays under 25 lines; supplementary docs in `.dork/docs/` loaded on demand.
- Pros: Base context always sharp and noticed; detailed knowledge available when needed; follows Anthropic's own AGENTS.md best practices.
- Cons: `@path` import syntax is Claude Code-specific (not supported by other runtimes). Requires creating and maintaining 3–4 supplementary files.
- Complexity: Low-Medium
- Maintenance: Medium (must update docs when DorkOS changes)

**Option C: Dynamic assembly at session start**

- Description: Server generates AGENTS.md content at session start by concatenating current DorkOS docs.
- Pros: Always up to date with the running version.
- Cons: Complexity, potential latency, over-engineering for v1.
- Complexity: High
- Maintenance: High

**Recommendation: Option B with Option A as fallback.** Write the `@path` import version as the primary; include a `AGENTS.md.fallback.md` (full inline version) in the template for non-Claude-Code runtimes. The server could detect the runtime and use the appropriate version when scaffolding.

For v1 where DorkBot only works with Claude Code, Option A (inline) is perfectly acceptable and simpler. Move to Option B when the knowledge base grows beyond 100 lines.

---

### Area 4: mkdir Security

**Option A: Leverage existing PathValidator + kebab-case input validation (recommended)**

- Description: Reuse the `PathValidator` class from `apps/server/src/utils/path-validator.ts` (already designed in `20260216_directory_boundary_sandbox.md`). Add a name-format validation layer before the path resolution.
- Pros: Consistent with existing security patterns, well-tested, handles all path traversal vectors.
- Cons: None for this use case.
- Complexity: Low (PathValidator already exists)
- Maintenance: Low

**Option B: Standalone validation in the creation route**

- Description: Inline the path validation logic directly in the `POST /api/agents` route handler.
- Pros: No dependency on shared utilities.
- Cons: Code duplication, inconsistent security guarantees, harder to test in isolation.
- Complexity: Low-Medium
- Maintenance: High (duplicated logic)

**Recommendation: Option A.** The existing infrastructure is exactly right. The creation pipeline adds one step before PathValidator: kebab-case name validation via regex.

---

## Security Considerations

### giget Template Safety

Templates downloaded from GitHub are untrusted code. The creation pipeline should:

1. **Never auto-run `postinstall` scripts.** The brief already resolves this correctly — show a prompt asking the user whether to run setup scripts. The server must NOT run `npm install` or similar commands automatically after template download.

2. **Validate template file count.** Before extracting, check that the tarball doesn't contain an unreasonable number of files (> 5,000 files is a red flag for a template). giget itself doesn't provide this — it requires inspecting the tarball before extraction, which is not practical for v1. Defer to user judgment on template source.

3. **Reject templates that overwrite `.dork/agent.json`.** After template download, DorkOS writes its own `.dork/agent.json`. If the template happened to include a `.dork/agent.json` (unlikely but possible for DorkOS-specific templates), DorkOS's version must take precedence. The creation pipeline spec already handles this ("Preserve any .dork/ files from template — don't overwrite with scaffolded versions"), but this should be inverted: **DorkOS-scaffolded files take precedence over template files for `.dork/` contents.**

4. **Symlink attacks in templates.** A malicious template could contain symlinks pointing outside the extraction directory. giget uses `node-tar` for extraction, which has had TOCTOU vulnerabilities in the past (see `node-tar` security advisory GHSA-r6q2-hw4h-h46w). Using the latest version of giget (which pins to a patched `node-tar`) is important. Monitor for giget version updates.

### mkdir Boundary Enforcement

The `POST /api/directory` endpoint (DirectoryPicker "New Folder") and `POST /api/agents` (agent creation) must both enforce the filesystem boundary. Two different boundaries apply:

1. **Agent creation (`POST /api/agents`):** The default root is `~/.dork/agents/`. The configurable override is `config.agents.defaultDirectory`. The target path must resolve to within this directory.

2. **DirectoryPicker "New Folder" (`POST /api/directory`):** The existing filesystem boundary (configured via `config.fileSystem.boundaryRoot`, default `os.homedir()`) applies. The new folder must be within the currently browsed path AND within the boundary root.

The security hierarchy for `POST /api/agents` path:

```
Input: agent name (kebab-case string, user-supplied)
  → Kebab-case regex validation
  → Resolve to: agentsRoot + "/" + name
  → PathValidator.validate(resolved, agentsRoot)
  → fs.mkdir(resolved, { recursive: false })
```

### Path Separator Edge Cases on macOS

macOS uses `/private/var` as the real path for `/var`. If `DORK_HOME` is configured as `/var/folders/...` (a common macOS temp path pattern), `fs.realpath()` will return the `/private/var/...` form. The `PathValidator` must normalize the boundary root at startup using `fs.realpath()` — this is already prescribed in `20260216_directory_boundary_sandbox.md`. The agent creation pipeline inherits this correctly by reusing PathValidator.

---

## Performance Considerations

### giget Download Time

Typical template sizes:

- `blank-agent` (DorkOS-owned): < 1KB — effectively instant
- `express-typescript` (edwinhern): ~500KB tarball — ~0.5–2 seconds
- `Next-js-Boilerplate` (ixartz): ~2–5MB tarball — ~3–10 seconds on typical broadband
- `full-stack-fastapi-template`: ~10–20MB — potentially 10–20 seconds

**Implication:** Template download should not block the UI. The creation flow should POST to `/api/agents`, receive an immediate acknowledgment (202 Accepted), and poll or SSE for completion. The creation dialog can show stage-by-stage progress ("Downloading template...", "Extracting...", "Scaffolding files...") without an actual progress percentage.

For the onboarding flow (DorkBot with "Blank" template), there is no template download — creation is essentially instant.

### Onboarding Animation Performance

The `AnimatePresence mode="wait"` text crossfade runs two concurrent opacity animations at 60fps. This is trivially cheap. The `deferredValue` debounce prevents excessive re-renders during slider scrubbing.

The `layoutId` bubble transition (onboarding → chat) is the most expensive animation in the entire flow. It involves:

- Position animation (the bubble moves across the screen)
- Size animation (the bubble resizes from centered card to chat message width)
- Radius animation (corner radius morphs)

For a 400ms duration, this is well within the budget for a one-time transition. It is NOT a repeated animation, so performance is not a concern.

**The avatar breathing animation** is a CSS animation on the compositor thread — zero JS cost. The `reacting` class toggle adds a single DOM class change.

### Context Window Impact (DorkBot)

DorkBot's AGENTS.md architecture (compact base + on-demand imports):

- Base AGENTS.md: ~25 lines ≈ ~300 tokens
- Each supplementary doc: ~50–100 lines ≈ ~600–1,200 tokens
- Total maximum loaded: ~4,000 tokens

This is well within the "under 1% of the 200K token window" threshold established in `20260303_agent_tool_context_injection.md`. The personality injection via SOUL.md adds another ~100–500 tokens. Combined budget is comfortable.

---

## Recommendations

### 1. giget Error Handling

**Use string inspection error classification in a wrapper function.** The five error cases (network, auth, 404, disk, unknown) cover all real-world scenarios. Write unit tests that mock the fetch layer to exercise each path. Do not attempt to extend or fork giget.

**Auth resolution order:** GITHUB_TOKEN env var → GIGET_AUTH env var → `gh auth token` CLI fallback (silent, timeout 3s). Document this in the DorkOS configuration guide.

**Stage-based progress (not percentage):** Four stages (validating, downloading, extracting, scaffolding) communicated via SSE. Client shows named stages with a spinner — no fake progress bar.

**No cancellation in v1.** Accept that template downloads cannot be interrupted once started. If the download takes more than 30 seconds (network issue), the server should timeout and return an error. Implement a 30s timeout via `Promise.race()` around the `downloadTemplate()` call.

### 2. Onboarding Personality Animation

**`AnimatePresence mode="wait"` with key-based text swap** is the correct pattern. Pair with `useDeferredValue` to prevent animation spam during slider scrubbing. The `y: 4 → 0` enter and `0 → y: -4` exit creates a "content updating" feel.

**The bubble container should react subtly (scale 1.02, deeper shadow) when traits change.** Use `motion.div` with `animate` props driven by `isChanging` state. This creates the "coming alive" quality the brief specifies without being distracting.

**Avatar breathing animation:** CSS animation, not Motion. 3s cycle normally, 0.8s when `reacting` class is present. Toggle `reacting` on slider `onMouseDown`, remove on `onMouseUp` with a 500ms delay.

**The onboarding → chat transition** should use `layoutId` on the bubble container. This is the most memorable moment in the entire onboarding flow and justifies the implementation complexity. Ensure `LayoutGroup` wraps both the onboarding and chat components to enable the shared element animation.

### 3. DorkBot AGENTS.md Content

**Start with the inline monolithic version (Option A) for v1.** Keep it under 80 lines. The content priorities:

1. Self-identity: what DorkBot is and where it runs (~3 lines)
2. What DorkOS subsystems exist and what they do (~10 lines — one sentence each for Pulse, Relay, Mesh)
3. Pointer to docs (if using `@path` imports) or inline documentation of key commands (~20 lines)
4. Behavior rules: 3–5 rules that are non-obvious and apply broadly (~5 lines)
5. Empty: everything else. Do not add sections about code style, general practices, or anything Claude already knows.

**Total target: 40–60 lines.** Not less (DorkBot would lack essential context) and not more (degraded instruction following above 80 lines).

**The SOUL.md for DorkBot** is separate from the AGENTS.md and contains the personality text rendered from the user's slider choices. The AGENTS.md is static product knowledge. SOUL.md is dynamic identity. They are injected into different parts of the system prompt.

### 4. mkdir Security

**Use existing PathValidator for all path operations.** Add a kebab-case regex gate before PathValidator for agent names specifically. The regex `^[a-z][a-z0-9-]{0,62}[a-z0-9]$|^[a-z]$` correctly describes valid agent names.

**Use `recursive: false` for the agent directory itself** to reliably detect collisions via `EEXIST`. Use `recursive: true` for the agents root directory to handle first-use idempotently.

**The `.dork/.creating` sentinel file pattern** is a good safeguard for detecting incomplete creation in the Mesh reconciler. The reconciler should skip agents with a recent `.creating` file and garbage-collect ones older than 5 minutes.

**Template files must NOT overwrite `.dork/agent.json`, `.dork/SOUL.md`, or `.dork/NOPE.md`.** The creation pipeline scaffolds these after template extraction. Step 4b in the pipeline spec ("Preserve any .dork/ files from template") should be inverted to "Always overwrite `.dork/` with scaffolded versions" — the DorkOS manifest is the authority, not a template's pre-configured agent identity.

---

## Things the Brief May Have Missed

1. **The 30-second download timeout.** The brief doesn't specify a timeout for template downloads. A stalled network request without a timeout will hang the creation pipeline indefinitely. Add `Promise.race()` with a 30s timeout. Return a clear error: "Template download timed out. Try again or use the Blank template."

2. **What happens when giget downloads to a non-empty directory.** If step 4 in the creation pipeline runs (template download) and the directory already has files (from a partial previous creation), giget will fail with an existing-directory error. The sentinel file pattern addresses this, but the server needs explicit logic to detect and clean up stale creation directories.

3. **Template network caching.** giget supports `preferOffline: true` which uses a local cache (`~/.cache/giget` or similar) if available. For repeated agent creation with the same template (common for development), this dramatically speeds up creation. The default call in the spec doesn't enable caching — add `preferOffline: true` to the options.

4. **DorkBot's AGENTS.md versioning.** When DorkOS is updated, DorkBot's scaffolded AGENTS.md will be out of date. The brief doesn't specify how to handle this. Options: (a) never auto-update (user is responsible), (b) offer "Refresh DorkBot knowledge" in settings, or (c) the "Recreate DorkBot" option also refreshes the docs. Option (b) is cleanest — add a settings button that overwrites `.dork/docs/` with the latest bundled versions without touching SOUL.md or NOPE.md.

5. **The `dorkbot` name reservation.** The brief says DorkBot is "not special at the system level" but the name `dorkbot` is clearly reserved (the default creation directory is `~/.dork/agents/dorkbot/`). The server should prevent non-onboarding creation flows from using the name `dorkbot` unless no DorkBot currently exists. Or, more practically: the name is not reserved — if a user creates an agent called `dorkbot` in a different directory, they get what they asked for. Only the directory path is fixed during onboarding.

6. **`preferOffline` during onboarding.** The blank template (no network needed) should always set `offline: true` to skip the network call entirely. It's a DorkOS-owned template — it should be bundled, not fetched.

---

## Research Gaps & Limitations

- **giget error messages are not formally documented.** The error classification patterns in this report are based on known behavior and GitHub Issues, not official documentation. They could break if giget changes its error formatting. A test suite exercising each error case is essential.
- **`layoutId` bubble transition implementation complexity** was not prototyped. The onboarding → chat `layoutId` animation requires both elements to exist simultaneously during the transition. The exact React lifecycle handling (when to mount the chat session, when to unmount the onboarding) requires careful implementation and may need a brief "transition" state in the router.
- **DorkBot AGENTS.md content quality** depends on the copywriting quality of the 40–60 lines. The structure is correct but the actual content requires a separate writing pass by someone who knows DorkOS well.
- **macOS-specific symlink paths** (`/var` → `/private/var`) are handled by PathValidator but were not tested against the new agents directory (`~/.dork/agents/`). Verify that `fs.realpath(path.join(os.homedir(), '.dork', 'agents'))` resolves consistently on macOS.

---

## Sources & Evidence

- [giget GitHub repository](https://github.com/unjs/giget) — API options, authentication patterns, GIGET_AUTH env var
- [giget Issue #194: "Maybe the error should be more descriptive"](https://github.com/unjs/giget/issues/194) — confirms generic error messages, no error taxonomy
- [@bluwy/giget-core](https://github.com/bluwy/giget-core) — simplified fork, confirms no progress callbacks or cancellation
- [Claude Code Best Practices — Anthropic](https://code.claude.com/docs/en/best-practices) — AGENTS.md guidelines, `@path` imports, under 300 lines recommendation, include/exclude table
- [Writing a good AGENTS.md — HumanLayer](https://www.humanlayer.dev/blog/writing-a-good-claude-md) — under 60 lines, manual crafting over `/init`, progressive disclosure into supplementary files
- [Motion AnimatePresence documentation](https://motion.dev/docs/react-animate-presence) — `mode="wait"`, key-based swap, crossfade patterns
- [Motion Layout Animations](https://motion.dev/docs/react-layout-animations) — `layoutId` shared element transitions for the onboarding → chat bubble morphing
- Prior research: `research/20260216_directory_boundary_sandbox.md` — PathValidator, path traversal prevention, TOCTOU, symlink handling (authoritative)
- Prior research: `research/20260321_agent_personality_convention_files_impl.md` — SOUL.md architecture, trait rendering, static lookup table approach (authoritative)
- Prior research: `research/20260323_agent_workspace_starter_templates.md` — giget basics, template catalog, programmatic API (authoritative)
- Prior research: `research/20260301_ftue_best_practices_deep_dive.md` — onboarding philosophy, empty states, Linear/Vercel patterns (authoritative)

---

## Search Methodology

- Searches performed: 14
- Prior research files consulted: 5 (covered most topics exhaustively)
- Most productive new search terms: "giget unjs error types FetchError", "AGENTS.md default agent template best practices 2025", "AnimatePresence mode wait crossfade text", "motion framer react crossfade animation slider"
- New web fetches: 4 (giget README, giget issue #194, giget-core README, Claude Code best practices, HumanLayer AGENTS.md guide)
- Topics adequately covered by prior research: filesystem security (20260216), SOUL.md/personality systems (20260321), template catalog (20260323), FTUE philosophy (20260301)
- Topics requiring new research: giget error handling specifics, AGENTS.md content architecture for DorkBot, `AnimatePresence mode="wait"` crossfade implementation
