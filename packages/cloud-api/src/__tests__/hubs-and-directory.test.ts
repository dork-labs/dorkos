/**
 * A person's own DorkOS in the cloud (the hub), its agent computers and how
 * they link to it, the viewer-open wake, the hub's next wake, the
 * full-control entitlement, and the account directory.
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
  AGENT_COMPUTER_BUSY_TTL_SECONDS,
  AGENT_COMPUTER_LINK_CODE_TTL_SECONDS,
  AgentComputerActivityRequestSchema,
  AgentComputerAssignmentSchema,
  AgentComputerLinkCodeRequestSchema,
  CloudComputerListResponseSchema,
  CloudComputerStartReasonSchema,
  CloudComputerStartRequestSchema,
  DirectoryReportRequestSchema,
  DirectorySchema,
  DirectorySettingsSchema,
  EntitlementLimitsSchema,
  HubAssignmentConfirmRequestSchema,
  HubAssignmentSchema,
  HubAssignmentStateSchema,
  HUB_NEXT_WAKE_MAX_AHEAD_DAYS,
  HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS,
  HubNextWakeRequestSchema,
  InferenceTokenRequestSchema,
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

  it('takes an address that is an origin and nothing more', () => {
    const full = fixture('hubs/assignment.json');
    for (const address of [
      'https://hub.example.invalid/',
      'https://hub.example.invalid/x',
      'https://hub.example.invalid?x=1',
      'https://user@hub.example.invalid',
    ]) {
      expect(HubAssignmentSchema.safeParse({ ...full, address }).success, address).toBe(false);
    }
  });

  it('publishes exactly the states the assignment union carries, so the two cannot drift', () => {
    const states = HubAssignmentSchema.options.map((option) => option.shape.state.value).sort();
    expect(states).toEqual([...HubAssignmentStateSchema.options].sort());
  });

  it('reads a state this release does not know as a failure, which a hub treats as pooled', () => {
    expect(HubAssignmentSchema.safeParse({ state: 'archived' }).success).toBe(false);
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

  it('confirms by naming the assignment and the hub`s own public key, never by echoing a secret', () => {
    expect(Object.keys(HubAssignmentConfirmRequestSchema.shape)).toEqual([
      'assignmentId',
      'signingPublicKey',
    ]);
  });

  it('takes only a raw 32-byte Ed25519 public key, and confirms without one', () => {
    const key = 'A'.repeat(42) + 'Q';
    expect(
      HubAssignmentConfirmRequestSchema.parse({ assignmentId: 'asg_1', signingPublicKey: key })
    ).toEqual({
      assignmentId: 'asg_1',
      signingPublicKey: key,
    });
    expect(HubAssignmentConfirmRequestSchema.safeParse({ assignmentId: 'asg_1' }).success).toBe(
      true
    );
    for (const bad of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}+`,
    ]) {
      expect(
        HubAssignmentConfirmRequestSchema.safeParse({
          assignmentId: 'asg_1',
          signingPublicKey: bad,
        }).success,
        bad
      ).toBe(false);
    }
  });

  it('carries no auth secret: the hub makes its own', () => {
    const names = fieldNames(HubAssignmentSchema, 'HubAssignmentSchema');
    // Every secret-shaped field anywhere in the assignment, so a new one has to
    // be added here on purpose.
    expect(names.filter((n) => /secret|password|key$/i.test(n))).toEqual(['secret']);
  });
});

describe('the hub re-read signal', () => {
  it('carries no key, no address and no assignment: the hub reads those itself', () => {
    const command = RemoteCommandSchema.parse({
      ...fixture('remote/command-hub-assignment-changed.json'),
      frontDoorProof: { header: 'x-a', secret: 'x'.repeat(40) },
      address: 'https://elsewhere.example.invalid',
    });
    expect(Object.keys(command).sort()).toEqual(['id', 'kind', 'leaseToken']);
  });
});

describe('cloud agent computers', () => {
  it('deletes a computer at its own route', () => {
    expect(v1Path.computer('cmp_1')).toBe('/v1/computers/cmp_1');
  });

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

describe('starting a computer', () => {
  it('takes no body, an empty one, or a reason, so a start from an older hub still works', () => {
    expect(CloudComputerStartRequestSchema.safeParse({}).success).toBe(true);
    expect(CloudComputerStartRequestSchema.parse({ reason: 'turn' })).toEqual({ reason: 'turn' });
    expect(CloudComputerStartReasonSchema.options).toEqual(['turn', 'viewer', 'beat']);
  });

  it('reads a reason added later as unrecognised rather than refusing the start', () => {
    expect(CloudComputerStartRequestSchema.parse({ reason: 'migration' }).reason).toBe(
      UNRECOGNISED
    );
    expect(CloudComputerStartRequestSchema.safeParse({ reason: 3 }).success).toBe(false);
  });
});

describe('linking an agent computer to its hub', () => {
  const code = fixture('hubs/computer-link-code-request.json');

  it('is handed over per computer, by the hub', () => {
    expect(v1Path.computerLinkCode('cmp_1')).toBe('/v1/computers/cmp_1/link-code');
    expect(v1Path.computerLinkCode('a/b')).toBe('/v1/computers/a%2Fb/link-code');
    expect(() => v1Path.computerLinkCode('..')).toThrow(TypeError);
  });

  it('takes a code shaped like the one a person`s own computer links with', () => {
    expect(AgentComputerLinkCodeRequestSchema.parse(code)).toEqual(code);
    for (const bad of [
      '7K3M9QXR2B4TVW8',
      '7K3M9QXR2B4TVW8HX',
      '7k3m9qxr2b4tvw8h',
      '7K3M-9QXR-2B4T-VW8H',
      'IK3M9QXR2B4TVW8H',
      'LK3M9QXR2B4TVW8H',
      'OK3M9QXR2B4TVW8H',
      'UK3M9QXR2B4TVW8H',
    ]) {
      expect(
        AgentComputerLinkCodeRequestSchema.safeParse({ ...code, code: bad }).success,
        bad
      ).toBe(false);
    }
  });

  it('refuses a code without the time it stops working', () => {
    expect(AgentComputerLinkCodeRequestSchema.safeParse({ code: code.code }).success).toBe(false);
    expect(AGENT_COMPUTER_LINK_CODE_TTL_SECONDS).toBe(600);
  });

  it('marks the code, and only the code, as a one-time credential', () => {
    const marked = walk(AgentComputerAssignmentSchema, 'AgentComputerAssignmentSchema')
      .filter(({ node }) => {
        const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
        return meta?.[ONE_TIME_CREDENTIAL_META] === true;
      })
      .map(({ path: at }) => at);
    expect(marked).toEqual(['AgentComputerAssignmentSchema.linkCode.code']);
  });
});

describe('an agent computer`s assignment', () => {
  it('reads a waiting code, and null once it was handed out', () => {
    const waiting = AgentComputerAssignmentSchema.parse(
      fixture('hubs/agent-computer-assignment.json')
    );
    expect(waiting.linkCode?.code).toHaveLength(16);
    const linked = AgentComputerAssignmentSchema.parse(
      fixture('hubs/agent-computer-assignment-linked.json')
    );
    expect(linked.linkCode).toBeNull();
    expect(linked.pollAfterSeconds).toBeUndefined();
  });

  it('is read at the computer`s own route', () => {
    expect(V1_ROUTES.agentComputerAssignment).toBe('/v1/agent-computers/self/assignment');
  });

  it('refuses one without its computer, hub, owner, issuer or code field', () => {
    const full = fixture('hubs/agent-computer-assignment.json');
    for (const field of ['computerId', 'hubOrigin', 'ownerAccountId', 'issuer', 'linkCode']) {
      const partial = { ...full };
      delete partial[field];
      expect(AgentComputerAssignmentSchema.safeParse(partial).success, field).toBe(false);
    }
  });

  it('takes a hub that is an https origin and nothing more', () => {
    const full = fixture('hubs/agent-computer-assignment.json');
    for (const hubOrigin of [
      'http://hub-0001.example.invalid',
      'https://hub-0001.example.invalid/',
      'https://hub-0001.example.invalid/api',
    ]) {
      expect(
        AgentComputerAssignmentSchema.safeParse({ ...full, hubOrigin }).success,
        hubOrigin
      ).toBe(false);
    }
  });

  it('carries no key for the computer: it makes its own, and the hub pins it', () => {
    const names = fieldNames(AgentComputerAssignmentSchema, 'AgentComputerAssignmentSchema');
    expect(names.filter((n) => /key|secret|token|password|mail/i.test(n))).toEqual([]);
  });

  it('is asked to read again by a command that carries nothing else', () => {
    const command = RemoteCommandSchema.parse({
      ...fixture('remote/command-agent-computer-assignment-changed.json'),
      linkCode: { code: '7K3M9QXR2B4TVW8H', expiresAt: '2026-11-03T12:10:00Z' },
      hubOrigin: 'https://elsewhere.example.invalid',
    });
    expect(command.kind).toBe('agent_computer_assignment_changed');
    expect(Object.keys(command).sort()).toEqual(['id', 'kind', 'leaseToken']);
    expect(RemoteCommandSchema.options.map((option) => option.shape.kind.value)).toContain(
      'agent_computer_assignment_changed'
    );
  });

  it('refuses the command without a lease token to settle it with', () => {
    expect(
      RemoteCommandSchema.safeParse({ kind: 'agent_computer_assignment_changed', id: 'cmd_1' })
        .success
    ).toBe(false);
  });
});

describe('an agent computer`s activity', () => {
  it('says busy or not, and nothing else', () => {
    expect(V1_ROUTES.agentComputerActivity).toBe('/v1/agent-computers/self/activity');
    expect(AgentComputerActivityRequestSchema.parse({ busy: false, until: 'x' })).toEqual({
      busy: false,
    });
    expect(AgentComputerActivityRequestSchema.safeParse({}).success).toBe(false);
    expect(AgentComputerActivityRequestSchema.safeParse({ busy: 'yes' }).success).toBe(false);
  });

  it('publishes how long busy holds, so a crashed turn cannot keep a computer running', () => {
    expect(AGENT_COMPUTER_BUSY_TTL_SECONDS).toBe(600);
  });
});

describe('a hub`s next wake', () => {
  it('takes a time or null, and nothing else', () => {
    expect(V1_ROUTES.hubNextWake).toBe('/v1/hubs/self/next-wake');
    expect(HubNextWakeRequestSchema.parse(fixture('hubs/next-wake-request.json')).at).toBe(
      '2026-11-04T07:00:00Z'
    );
    expect(HubNextWakeRequestSchema.parse({ at: null }).at).toBeNull();
    expect(HubNextWakeRequestSchema.safeParse({}).success).toBe(false);
    expect(HubNextWakeRequestSchema.safeParse({ at: 'tomorrow' }).success).toBe(false);
  });

  it('publishes the wake interval and how far ahead a wake counts', () => {
    expect(HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS).toBe(300);
    expect(HUB_NEXT_WAKE_MAX_AHEAD_DAYS).toBe(31);
  });
});

describe('inference on an agent computer', () => {
  it('says whose agent id `agentRef` is on an agent computer', () => {
    expect(InferenceTokenRequestSchema.shape.agentRef.description).toContain('on its hub');
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
      reportedAt: '2026-11-03T12:00:00Z',
      agents: [],
      spaces: [{ address: 'https://community.example.invalid', name: 'A', token: 'leak' }],
    });
    expect(parsed.spaces?.[0]).toEqual({ address: 'https://community.example.invalid', name: 'A' });
  });

  it('never takes a link to the computer from its own report', () => {
    const parsed = DirectoryReportRequestSchema.parse({
      reportedAt: '2026-11-03T12:00:00Z',
      agents: [],
      reach: 'full-control',
      remoteAddress: 'https://phish.example.invalid',
    });
    expect(parsed).not.toHaveProperty('remoteAddress');
  });

  it('says where a cloud agent works, and leaves it out for an agent on a person`s computer', () => {
    const directory = DirectorySchema.parse(fixture('directory/directory.json'));
    const cloud = directory.agents.find((agent) => agent.worksOn);
    expect(cloud?.instanceId).toBe('inst_0100');
    expect(directory.instances.find((i) => i.instanceId === cloud?.instanceId)?.role).toBe('hub');
  });

  it('leaves a space`s role and state null when only a computer reported it', () => {
    const directory = DirectorySchema.parse(fixture('directory/directory.json'));
    const reported = directory.spaces.find((space) => !space.sources.includes('service'));
    expect(reported?.role).toBeNull();
    expect(reported?.state).toBeNull();
  });

  it('refuses a space address that points at this machine, which means another one elsewhere', () => {
    for (const address of ['http://localhost:4242', 'http://127.0.0.1:4242']) {
      const report = {
        reportedAt: '2026-11-03T12:00:00Z',
        agents: [],
        spaces: [{ address, name: 'A' }],
      };
      expect(DirectoryReportRequestSchema.safeParse(report).success, address).toBe(false);
    }
  });

  it('refuses a report that names one space twice', () => {
    const space = { address: 'https://community.example.invalid', name: 'A' };
    const twice = { reportedAt: '2026-11-03T12:00:00Z', agents: [], spaces: [space, space] };
    expect(DirectoryReportRequestSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses a report without the time it was made, so a late retry can lose', () => {
    expect(DirectoryReportRequestSchema.safeParse({ agents: [] }).success).toBe(false);
  });

  it('keeps an absent part absent rather than turning it into an empty one', () => {
    const parsed = DirectoryReportRequestSchema.parse({
      reportedAt: '2026-11-03T12:00:00Z',
      agents: [],
    });
    expect(parsed).not.toHaveProperty('spaces');
    expect(parsed).not.toHaveProperty('reach');
  });

  it('refuses a report that names one agent twice', () => {
    const twice = {
      reportedAt: '2026-11-03T12:00:00Z',
      agents: [
        { agentId: 'a', name: 'A' },
        { agentId: 'a', name: 'B' },
      ],
    };
    expect(DirectoryReportRequestSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses a space address that is plain http to anywhere but this machine', () => {
    const plain = {
      reportedAt: '2026-11-03T12:00:00Z',
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
