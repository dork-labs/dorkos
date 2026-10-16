/**
 * A person's own DorkOS in the cloud (the hub), its agent computers, the
 * viewer-open wake, the full-control entitlement, and the account directory.
 *
 * The rules pinned here are the ones a later change could break quietly: a
 * pooled hub holds no keys, the owner is an account id at one issuer and never
 * an email, the wake never carries an address, and the directory remembers
 * where things are but never how to get in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CloudComputerListResponseSchema,
  DirectoryReportRequestSchema,
  DirectorySchema,
  DirectorySettingsSchema,
  EntitlementLimitsSchema,
  HubAssignmentConfirmRequestSchema,
  HubAssignmentSchema,
  ONE_TIME_CREDENTIAL_META,
  RemoteCommandSchema,
  UNRECOGNISED,
  V1_ROUTES,
  v1Path,
} from '../index.js';
import { walk } from './schema-walk.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

/** Every field name anywhere inside a schema, however deep. */
function fieldNames(schema: z.ZodTypeAny, root: string): string[] {
  return walk(schema, root).map(({ path: at }) =>
    (at.split('.').pop() ?? at).replace(/\[\d+]$/, '')
  );
}

describe('hub assignment', () => {
  it('gives a pooled hub nothing but its state, so it holds no key a visitor could use', () => {
    const pooled = HubAssignmentSchema.parse({
      state: 'pooled',
      ownerAccountId: 'acct_x',
      frontDoorProof: { header: 'x-a', secret: 'x'.repeat(40) },
    });
    expect(pooled).toEqual({ state: 'pooled' });
  });

  it('names the owner by account id at one issuer, and has no email field anywhere', () => {
    const assigned = HubAssignmentSchema.parse(fixture('hubs/assignment.json'));
    expect(assigned.state).toBe('assigned');
    expect(
      fieldNames(HubAssignmentSchema, 'HubAssignmentSchema').filter((n) => /mail/i.test(n))
    ).toEqual([]);
  });

  it('refuses an assignment without its owner, issuer, address or proof', () => {
    const full = fixture('hubs/assignment.json');
    for (const field of ['ownerAccountId', 'issuer', 'address', 'frontDoorProof']) {
      const partial = { ...full };
      delete partial[field];
      expect(HubAssignmentSchema.safeParse(partial).success, field).toBe(false);
    }
  });

  it('takes an https issuer and address only', () => {
    const full = fixture('hubs/assignment.json');
    for (const field of ['issuer', 'address']) {
      const plain = { ...full, [field]: 'http://hub.example.invalid' };
      expect(HubAssignmentSchema.safeParse(plain).success, field).toBe(false);
    }
  });

  it('marks the front-door secret as a one-time credential', () => {
    const marked = walk(HubAssignmentSchema, 'HubAssignmentSchema')
      .filter(({ node }) => {
        const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
        return meta?.[ONE_TIME_CREDENTIAL_META] === true;
      })
      .map(({ path: at }) => at);
    expect(marked).toEqual(['HubAssignmentSchema[1].frontDoorProof.secret']);
  });

  it('confirms by naming the assignment, never by echoing a key', () => {
    expect(Object.keys(HubAssignmentConfirmRequestSchema.shape)).toEqual(['assignmentId']);
  });

  it('carries no auth secret: the hub makes its own', () => {
    const names = fieldNames(HubAssignmentSchema, 'HubAssignmentSchema');
    expect(names.filter((n) => /authSecret|clientSecret|password/i.test(n))).toEqual([]);
  });
});

describe('cloud agent computers', () => {
  it('reads a state or stop reason added later as unrecognised, so one computer cannot fail the list', () => {
    const list = fixture('hubs/computers.json') as { items: Array<Record<string, unknown>> };
    const later = {
      items: [
        { ...list.items[0], state: 'hibernating' },
        { ...list.items[1], stopReason: 'moved' },
      ],
    };
    const parsed = CloudComputerListResponseSchema.parse(later);
    expect(parsed.items[0]?.state).toBe(UNRECOGNISED);
    expect(parsed.items[1]?.stopReason).toBe(UNRECOGNISED);
  });

  it('publishes start and stop as routes, so a hub never needs a supplier`s credentials', () => {
    expect(V1_ROUTES.computers).toBe('/v1/computers');
    expect(v1Path.computerStart('cmp_1')).toBe('/v1/computers/cmp_1/start');
    expect(v1Path.computerStop('cmp_1')).toBe('/v1/computers/cmp_1/stop');
  });
});

describe('the viewer-open wake', () => {
  it('parses as a command on the existing stream', () => {
    const command = RemoteCommandSchema.parse(fixture('remote/command-viewer-open.json'));
    expect(command.kind).toBe('viewer_open');
  });

  it('never carries an address: a computer dials only what it pinned', () => {
    const command = RemoteCommandSchema.parse({
      ...fixture('remote/command-viewer-open.json'),
      address: 'https://elsewhere.example.invalid',
      host: 'elsewhere.example.invalid',
    });
    expect(command).not.toHaveProperty('address');
    expect(command).not.toHaveProperty('host');
  });

  it('is asked for per computer', () => {
    expect(v1Path.instanceViewerOpen('inst_1')).toBe('/v1/instances/inst_1/viewer-open');
  });
});

describe('the full-control entitlement', () => {
  it('is optional, so an entitlement from an older service still parses', () => {
    const limits = (fixture('billing/entitlements-free.json') as { limits: unknown }).limits;
    const parsed = EntitlementLimitsSchema.parse(limits);
    expect(parsed.fullControl).toBeUndefined();
    expect(
      EntitlementLimitsSchema.parse({ ...(limits as object), fullControl: true }).fullControl
    ).toBe(true);
  });
});

describe('the account directory', () => {
  it('reads an empty account as empty lists, never a 404', () => {
    const empty = DirectorySchema.parse(fixture('directory/directory-empty.json'));
    expect(empty.instances).toEqual([]);
    expect(empty.spaces).toEqual([]);
  });

  it('remembers where a space is, never how to get in', () => {
    const names = fieldNames(DirectorySchema, 'DirectorySchema');
    expect(names.filter((n) => /token|secret|password|credential|cookie|session/i.test(n))).toEqual(
      []
    );
    const report = fieldNames(DirectoryReportRequestSchema, 'DirectoryReportRequestSchema');
    expect(
      report.filter((n) => /token|secret|password|credential|cookie|session/i.test(n))
    ).toEqual([]);
  });

  it('drops anything a computer adds to a space beyond its name and address', () => {
    const parsed = DirectoryReportRequestSchema.parse({
      agents: [],
      spaces: [{ address: 'https://community.example.invalid', name: 'A', token: 'leak' }],
    });
    expect(parsed.spaces?.[0]).toEqual({ address: 'https://community.example.invalid', name: 'A' });
  });

  it('never takes a link to the computer from its own report', () => {
    const parsed = DirectoryReportRequestSchema.parse({
      agents: [],
      reach: 'full-control',
      remoteAddress: 'https://phish.example.invalid',
    });
    expect(parsed).not.toHaveProperty('remoteAddress');
  });

  it('refuses a report that names one agent twice', () => {
    const twice = {
      agents: [
        { agentId: 'a', name: 'A' },
        { agentId: 'a', name: 'B' },
      ],
    };
    expect(DirectoryReportRequestSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses a space address that is plain http to anywhere but this machine', () => {
    const plain = {
      agents: [],
      spaces: [{ address: 'http://community.example.invalid', name: 'A' }],
    };
    expect(DirectoryReportRequestSchema.safeParse(plain).success).toBe(false);
  });

  it('takes quiet hours that cross midnight, and refuses a time that is not one', () => {
    const settings = fixture('directory/settings.json');
    expect(
      DirectorySettingsSchema.safeParse({
        ...settings,
        quietHours: { start: '22:00', end: '07:00' },
      }).success
    ).toBe(true);
    for (const bad of ['24:00', '7:00', '07:60', '0700']) {
      const parsed = DirectorySettingsSchema.safeParse({
        ...settings,
        quietHours: { start: bad, end: '07:00' },
      });
      expect(parsed.success, bad).toBe(false);
    }
  });

  it('reads a role, availability or source added later as unrecognised', () => {
    const directory = fixture('directory/directory.json') as {
      instances: Array<Record<string, unknown>>;
      spaces: Array<Record<string, unknown>>;
    };
    const later = {
      ...directory,
      instances: [{ ...directory.instances[0], role: 'phone', availability: 'asleep' }],
      spaces: [{ ...directory.spaces[0], sources: ['invite'] }],
    };
    const parsed = DirectorySchema.parse(later);
    expect(parsed.instances[0]?.role).toBe(UNRECOGNISED);
    expect(parsed.instances[0]?.availability).toBe(UNRECOGNISED);
    expect(parsed.spaces[0]?.sources).toEqual([UNRECOGNISED]);
  });
});
