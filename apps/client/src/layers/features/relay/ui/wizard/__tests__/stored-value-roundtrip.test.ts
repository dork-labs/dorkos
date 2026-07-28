/**
 * A stored list or object must survive being edited in the wizard.
 *
 * `dmAllowlist` and `approverAllowlist` persist as arrays, `channelOverrides` as
 * an object, but all three are edited in a `textarea`. Before DOR-640 surfaced
 * them they never rendered, so they round-tripped by never being touched. Once
 * rendered, handing the stored value straight to a textarea stringified it —
 * `["a","b"]` became the single line `a,b`, an object became `[object Object]` —
 * and saving that text wrote the nonsense back. For `approverAllowlist` that
 * silently revokes everyone who could approve a tool call.
 *
 * These start from a config that ALREADY HAS VALUES, which is the case the rest
 * of the suite does not cover: every other new test starts from a config with no
 * value for these keys, and that is the one case that always worked.
 *
 * ## This file is NOT the authority on the server half
 *
 * `serverNormalize` below is a local mirror of `normalizeFormConfig` in
 * `apps/server/src/services/relay/adapter-config.ts`, written out so the round
 * trip can be asserted without a server. It is a convenience, and it **cannot
 * detect drift**: change the real `normalizeFormConfig` and every assertion here
 * stays green. Which key is which shape is single-sourced on the manifest
 * (`valueShape`), but this transform is written twice.
 *
 * The seam is genuinely crossed in two places, and those are the authority:
 *
 * - `apps/server/src/services/relay/__tests__/adapter-roundtrip.test.ts` runs
 *   the real `parseAdapterConfigForPersist` against the real `SLACK_MANIFEST`.
 * - `apps/e2e/tests/relay/adapter-wizard-fields.spec.ts` drives a real browser
 *   against a real server and reads the saved config back.
 *
 * If you change `normalizeFormConfig`, change those — a green run here proves
 * nothing about it.
 */
import { describe, it, expect } from 'vitest';
import { initializeValues, unflattenConfig } from '../adapter-config-utils';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

/** The three shaped fields, declared exactly as the real Slack manifest declares them. */
const manifest: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Slack adapter',
  category: 'messaging',
  builtin: true,
  multiInstance: true,
  configFields: [
    {
      key: 'dmAllowlist',
      label: 'DM Allowlist',
      type: 'textarea',
      valueShape: 'id-list',
      required: false,
    },
    {
      key: 'approverAllowlist',
      label: 'Approvers',
      type: 'textarea',
      valueShape: 'id-list',
      required: false,
    },
    {
      key: 'channelOverrides',
      label: 'Channel Overrides',
      type: 'textarea',
      valueShape: 'json-object',
      required: false,
    },
    // A textarea with no declared shape stores plain text and must stay untouched.
    { key: 'notes', label: 'Notes', type: 'textarea', required: false },
  ],
};

const STORED = {
  dmAllowlist: ['U01ABC123', 'U02DEF456'],
  approverAllowlist: ['U01ABC123', 'U02DEF456'],
  channelOverrides: { C01ABC: { respondMode: 'always' }, C02DEF: { enabled: false } },
  notes: 'plain text',
};

/**
 * The server's half of the round trip, mirroring `normalizeFormConfig` in
 * `apps/server/src/services/relay/adapter-config.ts`: one id per line back into
 * an array, JSON text back into an object.
 */
function serverNormalize(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of manifest.configFields) {
    const value = config[field.key];
    if (field.valueShape === 'id-list') {
      out[field.key] = Array.isArray(value)
        ? value
        : String(value ?? '')
            .split('\n')
            .map((entry) => entry.trim())
            .filter(Boolean);
    } else if (field.valueShape === 'json-object') {
      out[field.key] = typeof value === 'string' ? JSON.parse(value || '{}') : (value ?? {});
    } else if (value !== '') {
      out[field.key] = value;
    }
  }
  return out;
}

describe('a stored value survives the wizard', () => {
  it('renders a stored id list as one entry per line, not comma-joined', () => {
    const values = initializeValues(manifest, STORED);

    expect(values.approverAllowlist).toBe('U01ABC123\nU02DEF456');
    expect(values.dmAllowlist).toBe('U01ABC123\nU02DEF456');
    // The shape the defect produced, pinned so it cannot come back.
    expect(values.approverAllowlist).not.toBe('U01ABC123,U02DEF456');
  });

  it('renders stored channel overrides as readable JSON, not [object Object]', () => {
    const values = initializeValues(manifest, STORED);

    expect(values.channelOverrides).toBe(JSON.stringify(STORED.channelOverrides, null, 2));
    expect(values.channelOverrides).not.toBe('[object Object]');
  });

  it('leaves a textarea with no declared shape exactly as stored', () => {
    expect(initializeValues(manifest, STORED).notes).toBe('plain text');
  });

  it('saving without editing writes back exactly what was stored', () => {
    const values = initializeValues(manifest, STORED);
    const saved = serverNormalize(unflattenConfig(values));

    expect(saved).toEqual(STORED);
  });

  it('adding one approver changes only that field, keeping the existing two', () => {
    const values = initializeValues(manifest, STORED);
    values.approverAllowlist = `${values.approverAllowlist as string}\nU03GHI789`;
    const saved = serverNormalize(unflattenConfig(values));

    expect(saved.approverAllowlist).toEqual(['U01ABC123', 'U02DEF456', 'U03GHI789']);
    // The defect collapsed the two existing ids into one bogus entry.
    expect(saved.approverAllowlist).not.toContain('U01ABC123,U02DEF456');
    expect(saved.dmAllowlist).toEqual(STORED.dmAllowlist);
    expect(saved.channelOverrides).toEqual(STORED.channelOverrides);
  });

  it('editing one channel override keeps the others', () => {
    const values = initializeValues(manifest, STORED);
    values.channelOverrides = JSON.stringify(
      { ...STORED.channelOverrides, C03GHI: { enabled: true } },
      null,
      2
    );
    const saved = serverNormalize(unflattenConfig(values));

    expect(saved.channelOverrides).toEqual({
      C01ABC: { respondMode: 'always' },
      C02DEF: { enabled: false },
      C03GHI: { enabled: true },
    });
  });

  it('removing every approver stores an empty list, not a list holding a blank', () => {
    const values = initializeValues(manifest, STORED);
    values.approverAllowlist = '';
    const saved = serverNormalize(unflattenConfig(values));

    expect(saved.approverAllowlist).toEqual([]);
  });
});
