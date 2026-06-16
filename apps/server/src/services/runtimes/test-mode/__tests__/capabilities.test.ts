/**
 * Contract tests for `TEST_MODE_CAPABILITIES`.
 *
 * Guards the DELIBERATE DIFFERENCE from `CLAUDE_CODE_CAPABILITIES`: if a
 * future edit makes the two shapes converge (overlapping permission-mode
 * ids or overlapping `features` keys), these tests fail and force the
 * editor to justify the convergence.
 */
import { describe, it, expect } from 'vitest';
import { TEST_MODE_CAPABILITIES } from '../runtime-constants.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../claude-code/runtime-constants.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

describe('TEST_MODE_CAPABILITIES', () => {
  it('declares exactly three permission modes', () => {
    expect(TEST_MODE_CAPABILITIES.permissionModes.supported).toBe(true);
    expect(TEST_MODE_CAPABILITIES.permissionModes.values).toHaveLength(3);
  });

  it('uses the expected test-mode permission-mode ids in order', () => {
    const ids = TEST_MODE_CAPABILITIES.permissionModes.values.map((v) => v.id);
    expect(ids).toEqual(['always-allow', 'always-deny', 'scripted']);
  });

  it('gives every permission-mode descriptor a non-empty label + description', () => {
    for (const descriptor of TEST_MODE_CAPABILITIES.permissionModes.values) {
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description).toBeDefined();
      expect(descriptor.description!.length).toBeGreaterThan(0);
    }
  });

  it('disables MCP, plugins, cost tracking, and interactive question prompts', () => {
    expect(TEST_MODE_CAPABILITIES.supportsMcp).toBe(false);
    expect(TEST_MODE_CAPABILITIES.supportsPlugins).toBe(false);
    expect(TEST_MODE_CAPABILITIES.supportsCostTracking).toBe(false);
    expect(TEST_MODE_CAPABILITIES.supportsQuestionPrompt).toBe(false);
  });

  it('keeps supportsResume and supportsToolApproval enabled for integration tests', () => {
    expect(TEST_MODE_CAPABILITIES.supportsResume).toBe(true);
    expect(TEST_MODE_CAPABILITIES.supportsToolApproval).toBe(true);
  });

  it('exposes the deterministic latency feature flag as 0', () => {
    expect(TEST_MODE_CAPABILITIES.features.deterministicLatencyMs).toBe(0);
  });

  it('lists only real built-in scenarios under features.testModeScenarios', () => {
    const scenarios = TEST_MODE_CAPABILITIES.features.testModeScenarios;
    expect(Array.isArray(scenarios)).toBe(true);
    // Keys must match BUILT_IN_SCENARIOS in scenario-store.ts.
    expect(scenarios).toEqual(['simple-text', 'tool-call', 'todo-write', 'error']);
  });

  it('is the object returned by TestModeRuntime.getCapabilities()', () => {
    const runtime = new TestModeRuntime();
    expect(runtime.getCapabilities()).toBe(TEST_MODE_CAPABILITIES);
  });

  it('declares no native context kinds (assembler bag rendered verbatim)', () => {
    expect(TEST_MODE_CAPABILITIES.nativeContext).toEqual([]);
  });
});

describe('cross-runtime capability contract', () => {
  it('test-mode and claude-code permission-mode ids do not overlap', () => {
    const claudeIds = new Set(CLAUDE_CODE_CAPABILITIES.permissionModes.values.map((v) => v.id));
    const testModeIds = new Set(TEST_MODE_CAPABILITIES.permissionModes.values.map((v) => v.id));
    const overlap = [...testModeIds].filter((id) => claudeIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('test-mode and claude-code features keys do not overlap', () => {
    const claudeKeys = new Set(Object.keys(CLAUDE_CODE_CAPABILITIES.features));
    const testModeKeys = new Set(Object.keys(TEST_MODE_CAPABILITIES.features));
    const overlap = [...testModeKeys].filter((k) => claudeKeys.has(k));
    expect(overlap).toEqual([]);
  });
});
