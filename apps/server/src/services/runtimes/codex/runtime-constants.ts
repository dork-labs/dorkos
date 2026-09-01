/**
 * Static configuration for the Codex runtime — capability flags and the
 * model catalog. Values are the task 2.2 verification verdicts (NOTES.md),
 * live-verified against the pinned `@openai/codex-sdk@0.142.5` and its
 * vendored CLI binary.
 *
 * @module services/runtimes/codex/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { EffortLevel, ModelOption } from '@dorkos/shared/types';

/**
 * Static Codex capabilities (NOTES.md Verdicts 1 & 2).
 *
 * - `supportsToolApproval: false` — `codex exec` has NO interactive approval
 *   channel (stdin closes after the prompt; approval-needing calls
 *   auto-cancel). Permission posture is upfront sandbox selection, and the
 *   approval UI is capability-gated off.
 * - `supportsCostTracking: false` — turn usage reports tokens (mapped to
 *   `session_status`), but Codex exposes no dollar-cost accounting, so the
 *   cost strip stays gated off.
 * - `supportsMcp: false` — DorkOS still cannot inject an in-process MCP tool
 *   server or apply per-agent tool-group filtering. The one exception is a
 *   single hard-wired stub: DorkOS registers one internal `dorkos_ui` MCP
 *   server via `CodexOptions.config` solely to expose `control_ui`, which the
 *   event-mapper translates into a `ui_command` StreamEvent (canvas parity
 *   with Claude Code). That narrow, non-configurable bridge does not amount to
 *   general MCP support, so this flag stays honestly `false`. User-configured
 *   servers in `~/.codex/config.toml` still stream as `mcp_tool_call` items
 *   and render as tool events.
 * - `supportsManagedMcpServers: true` — Codex DOES accept an agent's own
 *   managed MCP servers (the `mcp.*` verbs, spec `mcp-server-management`),
 *   injected per-turn as `--config mcp_servers.*` overrides through
 *   `CodexOptions.config` (stdio and streamable-HTTP; SSE has no Codex
 *   transport and is skipped). This is orthogonal to `supportsMcp` above:
 *   external managed servers work without the in-process DorkOS tool server
 *   (DOR-892). See {@link ./mcp-server-config}.
 * - Permission-mode ids reuse existing `PermissionModeSchema` members so the
 *   PATCH persistence path validates them (NOTES.md Verdict 2 enum decision).
 */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  // Every turn is a fresh subprocess (ADR-0309), and the only interrupt
  // primitive is an `AbortSignal` — there is no live session to steer into or
  // stage onto. Whether `@openai/codex-sdk` exposes anything like a mid-turn
  // steer is UNVERIFIED at the pin, so `false` is the honest answer until a
  // live probe says otherwise (spec `persistent-session-runtime` §2.6).
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  // History reconstructs from the DorkOS EventLog (no thread-read API), so the
  // platform persists it to the durable session-event store (DOR-189).
  logBackedHistory: true,
  permissionModes: {
    supported: true,
    // Matches `codex exec`'s own default posture (read-only sandbox).
    default: 'default',
    values: [
      {
        // Read-only, so it never has anything to ask about: `asks: 'never'` here
        // means "cannot ask", not "will not stop" — which is why the warning
        // tier reads `reach` too, and leaves a read-only mode alone.
        id: 'default',
        label: 'Read only',
        description:
          'Sandboxed reads — Codex can read files and answer questions, but not edit files, run mutating commands, or access the network.',
        stop: 'ask',
        asks: 'never',
        reach: 'read',
        promise: 'Reads files and answers questions. Nothing on your machine changes.',
        native: 'read-only',
      },
      {
        // THE divergent stop. `workspace-write` sits where the middle stop sits,
        // but Codex has no approval channel at all — it cannot pause mid-turn to
        // ask, so it runs shell commands unprompted. The promise says so in the
        // words a person would use, because the surface's whole job here is to
        // stop this being a surprise (spec `trust-dial`, decision 2).
        id: 'acceptEdits',
        label: 'Workspace write',
        description:
          'Codex can read, edit, and run commands inside the workspace. Network access stays off.',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
        native: 'workspace-write',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        description:
          'No sandbox — full file and network access. Use only in trusted or externally-sandboxed environments.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise:
          "Acts without approval prompts, anywhere on your machine, network included — and can't pause to ask.",
        native: 'danger-full-access',
      },
    ],
  },
  // Effort is real — every catalog model takes a reasoning level (see
  // `CODEX_EFFORT_LEVELS` below). No bespoke section: Codex's settings card is
  // the common execution defaults and nothing else.
  settings: { configSection: 'codex', supportsEffort: true, sections: [] },
  // Codex has no compaction/summarize API (`Thread.run` only, verified at the
  // 0.142.5 pin), so this stays honestly `false` permanently (DOR-109 task 2.3).
  commandIntents: { compact: { supported: false } },
  features: {},
};

/** Reasoning levels every catalog model supports at the 0.142.5 pin. */
const CODEX_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/** Context window shared by every catalog model at the 0.142.5 pin. */
const CODEX_CONTEXT_WINDOW = 272_000;

/**
 * What every catalog model below can do. Because {@link CODEX_MODELS} is a
 * hardcoded snapshot rather than a live probe, these are **static claims by
 * construction** — DorkOS asserting them, not the Codex SDK reporting them.
 * Kept in one constant, like {@link CODEX_CONTEXT_WINDOW} above, so correcting a
 * claim is a single edit and so a model that ever differs has to opt OUT
 * visibly (override the field on its own entry) rather than silently inherit a
 * wrong answer.
 *
 * `supportsToolUse` and `supportsImageOutput` are safe to assert: Codex drives a
 * tool-calling agent loop, so a model that could not call tools could not be in
 * this catalog at all, and none of the GPT-5.x reasoning models returns
 * generated images (OpenAI's image models are a separate line that Codex does
 * not expose). `supportsVision` is the softer of the three — true of every
 * GPT-5.x model at the pin, and the one to re-check first if a text-only model
 * is ever added.
 *
 * Re-verify on every SDK re-pin, alongside the effort levels and context window.
 */
const CODEX_MODEL_CAPABILITIES = {
  supportsToolUse: true,
  supportsVision: true,
  supportsImageOutput: false,
} as const satisfies Pick<
  ModelOption,
  'supportsToolUse' | 'supportsVision' | 'supportsImageOutput'
>;

/**
 * The models the pinned Codex CLI exposes (its embedded model manifest,
 * `visibility: "list"` entries). The CLI also maintains a remote models
 * cache, so this static catalog is a snapshot of the pin — re-verify on
 * every SDK re-pin.
 */
export const CODEX_MODELS: ModelOption[] = [
  {
    value: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    isDefault: true,
    contextWindow: CODEX_CONTEXT_WINDOW,
    supportsEffort: true,
    supportedEffortLevels: CODEX_EFFORT_LEVELS,
    ...CODEX_MODEL_CAPABILITIES,
    provider: 'openai',
    tier: 'flagship',
  },
  {
    value: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    contextWindow: CODEX_CONTEXT_WINDOW,
    supportsEffort: true,
    supportedEffortLevels: CODEX_EFFORT_LEVELS,
    ...CODEX_MODEL_CAPABILITIES,
    provider: 'openai',
    tier: 'balanced',
  },
  {
    value: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    contextWindow: CODEX_CONTEXT_WINDOW,
    supportsEffort: true,
    supportedEffortLevels: CODEX_EFFORT_LEVELS,
    ...CODEX_MODEL_CAPABILITIES,
    provider: 'openai',
    tier: 'fast',
  },
  {
    value: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    description: 'Coding-optimized model.',
    contextWindow: CODEX_CONTEXT_WINDOW,
    supportsEffort: true,
    supportedEffortLevels: CODEX_EFFORT_LEVELS,
    ...CODEX_MODEL_CAPABILITIES,
    provider: 'openai',
    tier: 'specialized',
  },
  {
    value: 'gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'Optimized for professional work and long-running agents.',
    contextWindow: CODEX_CONTEXT_WINDOW,
    supportsEffort: true,
    supportedEffortLevels: CODEX_EFFORT_LEVELS,
    ...CODEX_MODEL_CAPABILITIES,
    provider: 'openai',
    tier: 'balanced',
  },
];
