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
 * - Permission-mode ids reuse existing `PermissionModeSchema` members so the
 *   PATCH persistence path validates them (NOTES.md Verdict 2 enum decision).
 */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    // Matches `codex exec`'s own default posture (read-only sandbox).
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        description:
          'Sandboxed reads — Codex can read files and answer questions, but not edit files, run mutating commands, or access the network.',
      },
      {
        id: 'acceptEdits',
        label: 'Workspace write',
        description:
          'Codex can read, edit, and run commands inside the workspace. Network access stays off.',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        description:
          'No sandbox — full file and network access. Use only in trusted or externally-sandboxed environments.',
      },
    ],
  },
  features: {},
};

/** Reasoning levels every catalog model supports at the 0.142.5 pin. */
const CODEX_EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh'];

/** Context window shared by every catalog model at the 0.142.5 pin. */
const CODEX_CONTEXT_WINDOW = 272_000;

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
    provider: 'openai',
    tier: 'balanced',
  },
];
