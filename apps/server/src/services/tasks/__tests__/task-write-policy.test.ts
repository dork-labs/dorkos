/**
 * The drift guard for {@link TASK_WRITE_POLICY}, plus the matching behavior the
 * two enforcement surfaces depend on (DOR-504).
 *
 * The guard is the point of the table. A verdict per field is only worth having
 * if a NEW field cannot arrive without one — that is how `permissionMode` became
 * writable in the first place, by being added to a tool schema that nobody read
 * as a security surface. So this asserts the table and the Zod request schemas
 * match in BOTH directions, and fails the build until somebody records a
 * deliberate verdict for whatever they just added.
 *
 * ## One limit worth knowing before you trust a green run
 *
 * The schemas come from `@dorkos/shared`, which resolves to its BUILT DIST, not
 * to source. Add a field to `packages/shared/src/schemas.ts` and run this test
 * without rebuilding and it passes, because it is still comparing against the old
 * shape. CI is safe (turbo builds `shared` before the server's tests, so the gate
 * holds there), but locally run `pnpm --filter @dorkos/shared build` after
 * touching those schemas or this guard will wave your new field through.
 *
 * @module services/tasks/__tests__/task-write-policy
 */
import { describe, it, expect } from 'vitest';
import { CreateTaskRequestSchema, UpdateTaskRequestSchema } from '@dorkos/shared/schemas';
import {
  TASK_WRITE_POLICY,
  OPERATOR_ONLY_TASK_FIELDS,
  findOperatorOnlyTaskFields,
  describeOperatorOnlyTaskRefusal,
  refuseUnknownTaskUpdateFields,
} from '../task-write-policy.js';

/** Every field name a caller can put in a task create or update body. */
const REQUEST_FIELDS = [
  ...new Set([
    ...Object.keys(CreateTaskRequestSchema.shape),
    ...Object.keys(UpdateTaskRequestSchema.shape),
  ]),
].sort();

describe('TASK_WRITE_POLICY drift guard', () => {
  it('found the request schemas to compare against', () => {
    // A comparison against an empty field list is vacuously green, which is the
    // one way this guard could stop doing its job without saying so.
    expect(REQUEST_FIELDS.length).toBeGreaterThan(5);
  });

  it('classifies every field the create and update schemas accept', () => {
    const missing = REQUEST_FIELDS.filter((field) => !(field in TASK_WRITE_POLICY));
    expect(
      missing,
      missing.length
        ? `\n${missing.join('\n')}\n\nThese fields can be written through a task create or ` +
            `update and have no verdict in TASK_WRITE_POLICY. Decide whether an agent may set ` +
            `each one, and say so in the table. A field that decides how much an unattended run ` +
            `may do, or whether it is approved to run, is 'operator-only'.`
        : ''
    ).toEqual([]);
  });

  it('classifies nothing the schemas no longer accept', () => {
    const stale = Object.keys(TASK_WRITE_POLICY).filter((f) => !REQUEST_FIELDS.includes(f));
    expect(
      stale,
      stale.length
        ? `\n${stale.join('\n')}\n\nThese are in TASK_WRITE_POLICY but no task write schema ` +
            `accepts them. Remove them, so the table keeps describing the real write surface.`
        : ''
    ).toEqual([]);
  });

  it('keeps permissionMode and status operator-only', () => {
    // Named explicitly rather than left to the table: these two are the whole
    // reason the table exists (DOR-504), and a future edit that flips either one
    // should have to delete a test that says why.
    expect(TASK_WRITE_POLICY.permissionMode).toBe('operator-only');
    expect(TASK_WRITE_POLICY.status).toBe('operator-only');
    expect([...OPERATOR_ONLY_TASK_FIELDS].sort()).toEqual(['permissionMode', 'status']);
  });
});

describe('findOperatorOnlyTaskFields', () => {
  it('finds nothing in a body of ordinary fields', () => {
    expect(
      findOperatorOnlyTaskFields({ name: 'nightly', prompt: 'go', cron: '0 2 * * *' })
    ).toEqual([]);
  });

  it('finds permissionMode whatever its value is', () => {
    // Presence is the question, not the value: a caller that sent the field
    // reached for it, and this guard deliberately holds no opinion about which
    // modes are harmless.
    for (const value of ['bypassPermissions', 'acceptEdits', 'default', null, undefined, '']) {
      expect(findOperatorOnlyTaskFields({ permissionMode: value })).toEqual(['permissionMode']);
    }
  });

  it('finds status, the field that approves a task', () => {
    expect(findOperatorOnlyTaskFields({ status: 'active' })).toEqual(['status']);
  });

  it('names every offending field at once, sorted', () => {
    expect(
      findOperatorOnlyTaskFields({
        prompt: 'go',
        permissionMode: 'bypassPermissions',
        status: 'active',
      })
    ).toEqual(['permissionMode', 'status']);
  });

  it('reaches for nothing on a body that is not an object', () => {
    for (const body of [null, undefined, 'permissionMode', 42, ['permissionMode']]) {
      expect(findOperatorOnlyTaskFields(body)).toEqual([]);
    }
  });
});

describe('describeOperatorOnlyTaskRefusal', () => {
  it('tells the model nothing was written, names the field, and says what to do', () => {
    const message = describeOperatorOnlyTaskRefusal(['permissionMode']);
    // The "nothing changed" sentence is load-bearing: the failure this guards
    // against is a model believing its other fields landed.
    expect(message).toContain('changed nothing');
    expect(message).toContain('permissionMode');
    expect(message).toContain('DorkOS');
  });

  it('reads naturally for more than one field', () => {
    const message = describeOperatorOnlyTaskRefusal(['permissionMode', 'status']);
    expect(message).toContain('those fields');
    expect(message).not.toContain('that field');
  });
});

describe('refuseUnknownTaskUpdateFields (DOR-1568)', () => {
  it('lets a body of real update fields through', () => {
    expect(refuseUnknownTaskUpdateFields({ prompt: 'go', cron: '0 2 * * *', enabled: true })).toBe(
      null
    );
  });

  it('lets an empty or absent body through', () => {
    // Express 5 leaves `req.body` undefined on a POST with no payload, and a
    // caller that changed nothing changed nothing wrongly.
    for (const body of [{}, null, undefined, 'prompt', 42, ['prompt']]) {
      expect(refuseUnknownTaskUpdateFields(body)).toBe(null);
    }
  });

  it('names target and agentId, the two ways a caller asks to re-home a task', () => {
    const refusal = refuseUnknownTaskUpdateFields({ target: 'global', agentId: 'bot' })!;
    expect(refusal.code).toBe('unknown_task_field');
    expect(refusal.fields).toEqual(['agentId', 'target']);
    // The refusal has to say what to do instead, or a model just tries again.
    expect(refusal.message).toContain('delete this task and create it again');
  });

  it('tells a typo apart from a re-homing attempt', () => {
    const refusal = refuseUnknownTaskUpdateFields({ promt: 'typo' })!;
    expect(refusal.fields).toEqual(['promt']);
    expect(refusal.message).not.toContain('delete this task');
    // …and lists the fields that do exist, which is the actionable half.
    expect(refusal.message).toContain('prompt');
  });

  it('answers both halves at once when a body has each kind', () => {
    const refusal = refuseUnknownTaskUpdateFields({ agentId: 'bot', promt: 'typo' })!;
    expect(refusal.fields).toEqual(['agentId', 'promt']);
    expect(refusal.message).toContain('delete this task and create it again');
    expect(refusal.message).toContain('no such field');
  });

  it('accepts every field the update schema declares, so it cannot drift', () => {
    // The failure mode this guards: a field added to `UpdateTaskRequestSchema`
    // that this refusal has never heard of, turning a legitimate edit into a 400.
    for (const field of Object.keys(UpdateTaskRequestSchema.shape)) {
      expect(refuseUnknownTaskUpdateFields({ [field]: 'anything' }), field).toBe(null);
    }
  });
});
