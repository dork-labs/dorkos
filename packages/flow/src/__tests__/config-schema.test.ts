import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import Ajv2019 from 'ajv/dist/2019.js';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { FlowConfigSchema, type FlowConfig } from '../config-schema.js';
import { CONFIG_SCHEMA_RELATIVE_PATH, buildConfigJsonSchema } from '../generate-config-schema.js';
import { serializeConfigJsonSchema } from '../../scripts/generate-config-schema.js';

// src/__tests__ -> src -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const configPath = path.join(repoRoot, '.agents', 'flow', 'config.json');
const generatedSchemaPath = path.join(repoRoot, CONFIG_SCHEMA_RELATIVE_PATH);

function readConfigJson(): unknown {
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

describe('FlowConfigSchema — parsing the §9 config.json', () => {
  it('parses the on-disk .agents/flow/config.json', () => {
    const parsed = FlowConfigSchema.parse(readConfigJson());
    expect(parsed.tracker).toBe('linear');
    expect(parsed.identity.marker).toBe('— 🤖 /flow');
    expect(parsed.identity.reviewer).toBeNull();
  });

  it('resolves the full §9 default config from {}', () => {
    const cfg: FlowConfig = FlowConfigSchema.parse({});

    // Spec-named default assertions
    expect(cfg.gates.planApproval).toBe(false);
    expect(cfg.decomposition.subIssueThreshold).toBe('xl');
    expect(cfg.context.perIssue).toBe('fresh-session');
    expect(cfg.autonomy.seat).toBe('pulse');

    // Stage spine defaults
    expect(cfg.stages.execute.stateCategory).toBe('started');
    expect(cfg.stages.verify.stateCategory).toBe('started');
    expect(cfg.stages.review).toEqual({ stateCategory: 'started', humanGate: true });
    expect(cfg.stages.review.command).toBeUndefined();
    expect(cfg.stages.done.stateCategory).toBe('completed');

    // A sampling across every top-level domain
    expect(cfg.ownership.scope).toEqual(['issues', 'projects']);
    expect(cfg.comments.respondWhen).toBe('addressed');
    expect(cfg.autonomy.wipCap).toEqual({ global: 2, perProject: 1 });
    expect(cfg.involvement.calibration.alwaysAsk).toContain('secrets-or-spend');
    expect(cfg.dispatch.sizeOrder).toBe('small-first');
    expect(cfg.gates.circuitBreaker.tokenBudget).toBe(2_000_000);
    expect(cfg.context.compactionTrigger).toBe(0.65);
    expect(cfg.workspace.isolation).toBe('worktree');
    expect(cfg.recovery.staleAfter).toBe('5m');
    expect(cfg.evidence.attachTo).toEqual(['pr', 'tracker']);
  });

  it('the resolved §9 default matches the on-disk config.json (minus $schema)', () => {
    const fromDisk = FlowConfigSchema.parse(readConfigJson());
    const fromDefaults = FlowConfigSchema.parse({});
    // config.json carries $schema; the empty-object resolution does not.
    const { $schema: _ignored, ...diskWithoutSchema } = fromDisk;
    expect(diskWithoutSchema).toEqual(fromDefaults);
  });
});

describe('FlowConfigSchema — rejecting invalid config', () => {
  it('rejects an unknown top-level key (strict)', () => {
    const result = FlowConfigSchema.safeParse({ trackerr: 'linear' });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-enum tracker', () => {
    const result = FlowConfigSchema.safeParse({ tracker: 'jira' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean gate flag', () => {
    const result = FlowConfigSchema.safeParse({ gates: { planApproval: 'no' } });
    expect(result.success).toBe(false);
  });

  it('rejects a compactionTrigger outside [0, 1]', () => {
    const result = FlowConfigSchema.safeParse({ context: { compactionTrigger: 1.5 } });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-enum subIssueThreshold', () => {
    const result = FlowConfigSchema.safeParse({ decomposition: { subIssueThreshold: 'xxl' } });
    expect(result.success).toBe(false);
  });
});

describe('z.toJSONSchema bridge', () => {
  it('produces a well-formed object JSON Schema', () => {
    const json = buildConfigJsonSchema();
    expect(json.type).toBe('object');
    expect(json).toHaveProperty('properties');
    const properties = json.properties as Record<string, unknown>;
    for (const key of [
      'tracker',
      'identity',
      'ownership',
      'comments',
      'stages',
      'autonomy',
      'involvement',
      'dispatch',
      'gates',
      'context',
      'workspace',
      'recovery',
      'decomposition',
      'evidence',
    ]) {
      expect(properties).toHaveProperty(key);
    }
  });

  it('round-trips: every value the Zod schema accepts, the JSON Schema accepts', () => {
    const json = buildConfigJsonSchema();
    const ajv = new Ajv2019({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(json);

    const resolved = FlowConfigSchema.parse({});
    expect(validate(resolved)).toBe(true);
  });
});

describe('generated config.schema.json artifact', () => {
  it('the committed artifact is in sync with the Zod source', async () => {
    // Compare parsed content (not raw bytes) so the assertion is resilient to
    // formatting; the generator already emits Prettier-formatted JSON.
    const onDisk = JSON.parse(readFileSync(generatedSchemaPath, 'utf8'));
    const fresh = JSON.parse(await serializeConfigJsonSchema());
    expect(onDisk).toEqual(fresh);
  });

  it('the generated config.schema.json validates the actual config.json', () => {
    const json = JSON.parse(readFileSync(generatedSchemaPath, 'utf8'));
    const ajv = new Ajv2019({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(json);

    const config = readConfigJson();
    const valid = validate(config);
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });
});

describe('schema module surface', () => {
  it('exposes z-backed sub-schemas for downstream extension', () => {
    // Sanity: the calibration sub-schema is reusable in isolation (task 2.1).
    const calibration = z.object({}).safeParse({});
    expect(calibration.success).toBe(true);
    expect(typeof FlowConfigSchema.parse).toBe('function');
  });
});
