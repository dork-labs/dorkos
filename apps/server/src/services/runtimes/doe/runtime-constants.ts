import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** Host features proven by the Doe adapter; the app calls this runtime DorkOS. */
export const DOE_CAPABILITIES: RuntimeCapabilities = {
  type: 'doe',
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsCostTracking: true,
  supportsToolApproval: true,
  supportsQuestionPrompt: false,
  supportsPlugins: true,
  supportsAccounts: false,
  // A fresh facade runs each turn against durable model records, without an idle process.
  supportsPersistentSession: false,
  supportsSteer: true,
  supportsContextStaging: false,
  nativeContext: [],
  logBackedHistory: true,
  mediaOutput: 'none',
  permissionModes: {
    supported: true,
    default: 'default',
    // The engine approval callback accepts allow/deny, never a model-facing reason.
    denyReason: false,
    values: [
      {
        id: 'default',
        label: 'Ask first',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        description: 'Reads freely and asks before changes.',
        promise: 'Reads files freely. Changes need approval; commands need full autonomy.',
      },
      {
        id: 'acceptEdits',
        label: 'Auto edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        description: 'Edits working files freely. Other actions need approval.',
        promise: 'Edits working files freely. Other actions ask; commands need full autonomy.',
      },
      {
        id: 'bypassPermissions',
        label: 'Full autonomy',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        description: 'Works without approval prompts, including commands.',
        promise: 'Works without approval prompts. Commands can reach outside working files.',
      },
    ],
  },
  settings: {
    configSection: 'doe',
    supportsEffort: false,
    sections: [{ kind: 'credits-runs-on' }, { kind: 'runtime-usage' }],
  },
  commandIntents: { compact: { supported: true } },
  credits: { protocol: 'anthropic-messages', scope: 'conversation' },
  features: {},
};
