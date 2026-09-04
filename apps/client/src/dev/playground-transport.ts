import type { Transport } from '@dorkos/shared/transport';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Runtime capabilities the playground answers `getCapabilities` with — a mirror of
 * the server's `CLAUDE_CODE_CAPABILITIES`, `CODEX_CAPABILITIES`, and
 * `OPENCODE_CAPABILITIES` (`apps/server/src/services/runtimes/<name>/runtime-constants.ts`).
 *
 * The one call in the transport that must not resolve `null`. Permission-mode labels
 * are declared by the runtime, so with no capabilities `PermissionModeItem` falls
 * back to its own built-in short names — `Bypass All` (10 characters) where Claude
 * Code's real descriptor says `Bypass permissions` (18). The status-line showcase
 * exists to show how much a measured width budget can hold, and a demo quietly
 * shaving ~50px off its widest value would be showing a line the app never draws.
 *
 * A copy can go stale: if a runtime renames a mode, this list is not updated for it.
 * What the showcases depend on is label *length*, so keep the longest ones in step.
 *
 * Exported because the props-only showcases read it directly: the runtime cards
 * are handed declared modes and a declared settings surface rather than fetching
 * them, and a fourth hand-written copy of each runtime's declaration is exactly
 * the drift this one exists to avoid.
 */
export const PLAYGROUND_CAPABILITIES: Record<string, RuntimeCapabilities> = {
  'claude-code': {
    type: 'claude-code',
    supportsToolApproval: true,
    supportsCostTracking: true,
    supportsResume: true,
    supportsMcp: true,
    supportsManagedMcpServers: true,
    supportsQuestionPrompt: true,
    supportsPlugins: true,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    mediaOutput: 'none',
    nativeContext: [],
    permissionModes: {
      supported: true,
      default: 'default',
      values: [
        {
          id: 'default',
          label: 'Default',
          stop: 'ask',
          asks: 'always',
          reach: 'edit',
          promise: 'Asks before it edits a file or runs a command.',
        },
        {
          id: 'acceptEdits',
          label: 'Accept edits',
          stop: 'act',
          asks: 'when-risky',
          reach: 'edit',
          promise: 'Edits files on its own. Asks before it runs a command.',
        },
        {
          id: 'plan',
          label: 'Plan',
          stop: 'ask',
          asks: 'always',
          reach: 'read',
          promise: 'Reads and plans only. Nothing changes until you approve the plan.',
        },
        {
          id: 'bypassPermissions',
          label: 'Bypass permissions',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise:
            'Acts without approval prompts, including outside this project. It will not stop to ask you.',
        },
        {
          id: 'auto',
          label: 'Auto',
          stop: 'act',
          asks: 'when-risky',
          reach: 'edit',
          promise:
            'Edits files on its own and weighs each command, asking you about the risky ones.',
        },
      ],
    },
    commandIntents: { compact: { supported: true } },
    // The real claude-code declaration — phase-2 settings showcases render off
    // this transport, so a filler here would show a screen the app never draws.
    settings: {
      configSection: 'claudeCode',
      supportsEffort: true,
      sections: [{ kind: 'claude-accounts' }],
    },
    features: {},
  },
  codex: {
    type: 'codex',
    supportsToolApproval: false,
    supportsCostTracking: false,
    supportsResume: true,
    supportsMcp: false,
    supportsManagedMcpServers: true,
    supportsQuestionPrompt: false,
    supportsPlugins: false,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    mediaOutput: 'none',
    nativeContext: [],
    logBackedHistory: true,
    permissionModes: {
      supported: true,
      default: 'default',
      values: [
        {
          id: 'default',
          label: 'Read only',
          stop: 'ask',
          asks: 'never',
          reach: 'read',
          promise: 'Reads files and answers questions. Nothing changes.',
          native: 'read-only',
        },
        {
          id: 'acceptEdits',
          label: 'Workspace write',
          stop: 'act',
          asks: 'never',
          reach: 'workspace',
          promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
          native: 'workspace-write',
        },
        {
          id: 'bypassPermissions',
          label: 'Full access',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise:
            "Acts without approval prompts, anywhere on your machine, network included — and can't pause to ask.",
          native: 'danger-full-access',
        },
      ],
    },
    commandIntents: { compact: { supported: false } },
    settings: { configSection: 'codex', supportsEffort: true, sections: [] },
    features: {},
  },
  opencode: {
    type: 'opencode',
    supportsToolApproval: true,
    supportsCostTracking: true,
    supportsResume: true,
    supportsMcp: false,
    supportsManagedMcpServers: false,
    supportsQuestionPrompt: false,
    supportsPlugins: false,
    supportsPersistentSession: false,
    supportsSteer: false,
    supportsContextStaging: false,
    mediaOutput: 'none',
    nativeContext: [],
    logBackedHistory: true,
    permissionModes: {
      supported: true,
      default: 'default',
      values: [
        {
          id: 'default',
          label: 'Default',
          stop: 'ask',
          asks: 'always',
          reach: 'edit',
          promise: 'Asks before it edits a file or runs a command.',
        },
        {
          id: 'acceptEdits',
          label: 'Accept edits',
          stop: 'act',
          asks: 'when-risky',
          reach: 'edit',
          promise: 'Edits files on its own. Asks before it runs a command.',
        },
        {
          id: 'bypassPermissions',
          label: 'Bypass permissions',
          stop: 'autonomy',
          asks: 'never',
          reach: 'everything',
          promise:
            'Acts without approval prompts, including outside this project. It will not stop to ask you.',
        },
      ],
    },
    commandIntents: { compact: { supported: true } },
    settings: {
      configSection: 'opencode',
      supportsEffort: false,
      sections: [{ kind: 'opencode-power-source' }],
    },
    features: {},
  },
};

/**
 * Proxy-based mock Transport for the dev playground.
 *
 * Every method resolves with `null` — the safest default for TanStack Query hooks
 * that may expect arrays, objects, or other shapes. TanStack Query rejects
 * `undefined` (it uses it internally for "no data yet"), but `null` is valid data
 * that still short-circuits optional chaining (`null?.field === undefined`).
 *
 * `getCapabilities` is the one exception: see {@link PLAYGROUND_CAPABILITIES}.
 *
 * Unlike `createMockTransport` from test-utils, this has no dependency on
 * `vi.fn()` and works at runtime.
 */
export function createPlaygroundTransport(): Transport {
  return new Proxy({} as Transport, {
    get: (_target, prop) => {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'getCapabilities') {
        return async () => ({
          capabilities: PLAYGROUND_CAPABILITIES,
          defaultRuntime: 'claude-code',
        });
      }
      // The second call that must not resolve `null`. The inbox bell is part of
      // `OneBar`'s fixed cluster, so it is on screen in every bar showcase — and
      // its infinite query reads `nextCursor` off the page it is handed, which
      // threw on `null` and turned every bar into a red error card. An empty
      // page is the honest answer for a playground with no server: a quiet bell.
      if (prop === 'listNotifications') {
        return async () => ({ notifications: [], nextCursor: null, unreadCount: 0 });
      }
      // The third pair. Remote access is a switch the playground can actually
      // flip (the Remote Access showcase), and `null` is not a start result —
      // the shared model reads `result.url` off it and would turn a working
      // demo into a red failure state. A made-up address is the honest answer
      // for a playground with no server, and stopping simply succeeds.
      if (prop === 'startTunnel') {
        return async () => ({ url: 'https://calm-otter.ngrok.app' });
      }
      if (prop === 'stopTunnel') {
        return async () => undefined;
      }
      // A room's files answer with a LISTING, and `null` is not one —
      // the room panel's Files section would map over it and turn the whole
      // sheet showcase into an error card. "This room has no files of its own"
      // is both the honest default and what nearly every room really says, so
      // the section shows nothing, which is what it does in the app.
      if (
        prop === 'readRoomFiles' ||
        prop === 'readRoomFileContent' ||
        prop === 'readRoomRepoStatus' ||
        prop === 'saveRoomFile' ||
        prop === 'repairRoomMain'
      ) {
        return async () => {
          throw Object.assign(new Error('This room does not have files of its own.'), {
            code: 'ROOM_HAS_NO_REPO',
            status: 409,
          });
        };
      }
      // Resolve with null — safe for hooks expecting arrays, objects, or primitives
      return async () => null;
    },
  });
}
