/** Fixed cases for original execution-defaults and power predicates. */
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { OriginalDefaultsScenario } from './room-original-native-defaults-control.js';
const base = USER_CONFIG_DEFAULTS.runtimes;
const model: UserConfig['runtimes'] = {
  ...base,
  claudeCode: { ...base.claudeCode, defaultModel: 'opus', defaultEffort: 'high' },
};
const stop = (value: 'ask' | 'act' | 'autonomy'): UserConfig['runtimes'] => ({
  ...base,
  defaultTrustStop: value,
});
export const originalClaudeDefaultsScenarios = {
  'durable-claude-boundaries': { history: 'boundaries', expectedSettings: {} },
  'durable-claude-no-text': {
    history: 'no-text',
    providerFragments: ['Green', ' — ', 'nothing failed.'],
    expectedSettings: {},
  },
  'defaults-server': { runtimes: model, expectedSettings: { model: 'opus', effort: 'high' } },
  'defaults-existing': {
    runtimes: { ...base, claudeCode: { ...base.claudeCode, defaultModel: 'opus' } },
    existing: { model: 'sonnet' },
    expectedSettings: {},
  },
  'defaults-empty': { expectedSettings: {} },
  'defaults-agent': {
    runtimes: model,
    manifest: { runtime: 'claude-code', model: 'sonnet', effort: 'low' },
    expectedSettings: { model: 'sonnet', effort: 'low' },
  },
  'defaults-missing-runtime': {
    runtimes: { ...base, claudeCode: { ...base.claudeCode, defaultModel: 'opus' } },
    manifest: { runtime: 'codex', model: 'gpt-5.3-codex' },
    expectedSettings: { model: 'opus' },
  },
  'defaults-registered-codex': {
    runtime: 'codex',
    manifest: { runtime: 'codex', model: 'gpt-5.3-codex' },
    expectedSettings: { model: 'gpt-5.3-codex' },
  },
  'defaults-kept-effort': {
    runtimes: model,
    manifest: { runtime: 'claude-code', model: 'sonnet' },
    expectedSettings: { model: 'sonnet', effort: 'high' },
  },
  'defaults-relay-equality': {
    runtimes: model,
    manifest: { runtime: 'claude-code', model: 'claude-haiku-4-5', effort: 'low' },
    compareRelay: true,
    expectedSettings: { model: 'claude-haiku-4-5', effort: 'low' },
  },
  'power-first': {
    runtimes: stop('autonomy'),
    expectedSettings: {},
    expectedMode: 'bypassPermissions',
  },
  'power-origin': {
    runtimes: stop('autonomy'),
    expectedSettings: {},
    expectedMode: 'bypassPermissions',
  },
  'power-vocabulary': { runtimes: stop('act'), expectedSettings: {}, expectedMode: 'acceptEdits' },
  'power-gate-clamps': {
    runtimes: stop('ask'),
    manifest: { runtime: 'claude-code', permissions: { filesAndCommands: 'autonomy' } },
    permission: 'discard',
    expectedSettings: {},
    expectedMode: 'default',
  },
  'power-gate-keeps': {
    runtimes: stop('ask'),
    manifest: { runtime: 'claude-code' },
    permission: 'keep',
    expectedSettings: {},
    expectedMode: 'bypassPermissions',
  },
  'power-runtime-beats-global': {
    runtimes: { ...stop('autonomy'), claudeCode: { ...base.claudeCode, defaultTrustStop: 'ask' } },
    expectedSettings: {},
    expectedMode: 'default',
  },
  'power-omitted': { expectedSettings: {} },
  'power-existing': {
    runtimes: stop('autonomy'),
    existing: { permissionMode: 'default' },
    expectedSettings: {},
  },
  'power-external-clamp': { runtimes: stop('autonomy'), external: true, expectedSettings: {} },
  'power-external-model': {
    runtimes: { ...stop('autonomy'), claudeCode: { ...base.claudeCode, defaultModel: 'opus' } },
    external: true,
    expectedSettings: { model: 'opus' },
  },
  'power-model-and-mode': {
    runtimes: { ...stop('autonomy'), claudeCode: { ...base.claudeCode, defaultModel: 'opus' } },
    expectedSettings: { model: 'opus' },
    expectedMode: 'bypassPermissions',
  },
  'power-stranger-existing': {
    runtimes: stop('autonomy'),
    existing: { permissionMode: 'bypassPermissions' },
    external: true,
    priorFullTurn: true,
    expectedCeiling: 'runtime-default',
    expectedLevel: { asks: 'always', reach: 'edit' },
    expectedSettings: {},
  },
  'power-agent-bound': {
    runtimes: stop('autonomy'),
    existing: { permissionMode: 'bypassPermissions' },
    agentAuthor: true,
    expectedCeiling: { asks: 'when-risky', reach: 'edit' },
    expectedLevel: { asks: 'when-risky', reach: 'edit' },
    expectedSettings: {},
  },
  'power-human-unbounded': {
    runtimes: stop('autonomy'),
    existing: { permissionMode: 'bypassPermissions' },
    expectedLevel: { asks: 'never', reach: 'everything' },
    expectedSettings: {},
  },
} as const satisfies Record<string, OriginalDefaultsScenario>;
