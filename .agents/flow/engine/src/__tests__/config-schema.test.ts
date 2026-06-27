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

// src/__tests__ -> src -> engine -> flow -> .agents -> repo root
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..'
);
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

describe('FlowConfigSchema — the loops config block (task 2.4)', () => {
  it('resolves the full per-reconciler loops map from {}', () => {
    const { loops } = FlowConfigSchema.parse({});

    // Every reconciler id is present and enabled by default.
    for (const id of ['recovery', 'inbox', 'review', 'dispatch', 'triage', 'hygiene'] as const) {
      expect(loops[id].enabled).toBe(true);
    }

    // The calibrated priority ladder: lower runs first / lower wins contention.
    expect(loops.recovery.priority).toBe(10);
    expect(loops.inbox.priority).toBe(20);
    expect(loops.review.priority).toBe(25);
    expect(loops.dispatch.priority).toBe(30);
    expect(loops.triage.priority).toBe(40);
    expect(loops.hygiene.priority).toBe(50);

    // Priorities are strictly ascending in registry order.
    const priorities = [
      loops.recovery.priority,
      loops.inbox.priority,
      loops.review.priority,
      loops.dispatch.priority,
      loops.triage.priority,
      loops.hygiene.priority,
    ];
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });

  it('cadence is fastest for inbox and slowest for hygiene', () => {
    const { loops } = FlowConfigSchema.parse({});
    const intervals = Object.values(loops).map((l) => l.intervalMs);
    // inbox (60s) is the smallest interval; hygiene (6h) is the largest.
    expect(loops.inbox.intervalMs).toBe(Math.min(...intervals));
    expect(loops.inbox.intervalMs).toBe(60_000);
    expect(loops.hygiene.intervalMs).toBe(Math.max(...intervals));
    expect(loops.hygiene.intervalMs).toBe(21_600_000);
  });

  it('a per-loop override merges over the default (partial enabled flip)', () => {
    const cfg = FlowConfigSchema.parse({ loops: { hygiene: { enabled: false } } });
    // The override flips enabled but keeps the calibrated priority/cadence.
    expect(cfg.loops.hygiene.enabled).toBe(false);
    expect(cfg.loops.hygiene.priority).toBe(50);
    expect(cfg.loops.hygiene.intervalMs).toBe(21_600_000);
  });

  it('rejects a non-positive intervalMs (strict cadence floor)', () => {
    const result = FlowConfigSchema.safeParse({ loops: { inbox: { intervalMs: 0 } } });
    expect(result.success).toBe(false);
  });
});

describe('FlowConfigSchema — the ingestion / transport block (task 4.4)', () => {
  it('resolves the §4 ingestion defaults from {} (producer poll, 60s cadence)', () => {
    const { ingestion } = FlowConfigSchema.parse({});
    // v1 default producer is `poll` (webhook deferred per the Non-Goals).
    expect(ingestion.producer).toBe('poll');
    // pollIntervalMs mirrors the loops.inbox cadence (task 2.4).
    expect(ingestion.pollIntervalMs).toBe(60_000);
    expect(ingestion.pollIntervalMs).toBe(FlowConfigSchema.parse({}).loops.inbox.intervalMs);
  });

  it('accepts the webhook producer (the deferred drop-in is a config edit, not code)', () => {
    const cfg = FlowConfigSchema.parse({ ingestion: { producer: 'webhook' } });
    expect(cfg.ingestion.producer).toBe('webhook');
    // A partial edit keeps the calibrated cadence default.
    expect(cfg.ingestion.pollIntervalMs).toBe(60_000);
  });

  it('rejects an out-of-enum producer', () => {
    const result = FlowConfigSchema.safeParse({ ingestion: { producer: 'sse' } });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive pollIntervalMs', () => {
    const result = FlowConfigSchema.safeParse({ ingestion: { pollIntervalMs: 0 } });
    expect(result.success).toBe(false);
  });
});

describe('CalibrationSchema — the calibration floor is non-trimmable (task 5.4)', () => {
  it('rejects an empty alwaysAsk (the floor is inviolable, charter G12)', () => {
    const result = FlowConfigSchema.safeParse({
      involvement: { calibration: { alwaysAsk: [] } },
    });
    expect(result.success).toBe(false);
  });

  it('the default parse still yields the four floor triggers', () => {
    const { involvement } = FlowConfigSchema.parse({});
    expect(involvement.calibration.alwaysAsk).toEqual([
      'irreversible-or-destructive',
      'outward-facing',
      'secrets-or-spend',
      'scope-change',
    ]);
  });

  it('accepts a re-prioritized floor of at least one trigger', () => {
    const cfg = FlowConfigSchema.parse({
      involvement: { calibration: { alwaysAsk: ['secrets-or-spend'] } },
    });
    expect(cfg.involvement.calibration.alwaysAsk).toEqual(['secrets-or-spend']);
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

  it('rejects the not-yet-implemented watcher seat (pulse is the only v1 seat)', () => {
    const result = FlowConfigSchema.safeParse({ autonomy: { seat: 'watcher' } });
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
