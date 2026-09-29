/**
 * The approval card for a connected-app action names the app, the account, the
 * action and its arguments (DOR-2504), all read by the server from stored
 * records — never from the agent's own words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorUsageAttempts,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ApprovalServiceActionSchema } from '@dorkos/shared/approval-schemas';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import type { ConnectorExternalAccountRef } from '@dorkos/shared/connector-provider';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import { ApprovalService } from '../../../core/approvals/index.js';
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/index.js';
import {
  CapabilityGateRefusal,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { ConnectorRegistry } from '../../registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { describeServiceAction, type ServiceActionFacts } from '../approval-service-action.js';
import { ConnectorExecutionAuthorizationService } from '../authorization-service.js';
import type { ConnectorExecutionBroker } from '../execution-broker.js';
import type { ConnectorAccessQueryService } from '../access-query-service.js';
import { connectorExecutionDomain } from '../execution-capabilities.js';

/**
 * Join the parts of a fake credential at run time. Every key shape in this file
 * is built this way so no literal credential appears in source, where secret
 * scanners (and GitHub push protection) would rightly flag it.
 */
function fake(...parts: string[]): string {
  return parts.join('');
}

/** A token-shaped value, the kind every broadcast string is swept for. */
const TOKEN = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';

const DELETE_SCHEMA = {
  type: 'object',
  properties: {
    message_id: { type: 'string', title: 'Message Id' },
    user_id: { type: 'string', title: 'User Id', default: 'me' },
    permanent: { type: 'boolean' },
  },
  required: ['message_id'],
};

function facts(over: Partial<ServiceActionFacts> = {}): ServiceActionFacts {
  return {
    toolkit: 'gmail',
    connectionLabel: 'gmail',
    identityHint: 'work@acme.com',
    operationSlug: 'GMAIL_DELETE_MESSAGE',
    inputSchema: DELETE_SCHEMA,
    arguments: { message_id: '18c2f0a9d1', permanent: true },
    ...over,
  };
}

describe('describeServiceAction', () => {
  it('names the app, the account and the action in plain words', () => {
    expect(describeServiceAction(facts())).toEqual({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'work@acme.com',
      actionName: 'Delete message',
      details: [
        { label: 'Message ID', value: '18c2f0a9d1' },
        { label: 'Permanent', value: 'Yes' },
      ],
    });
  });

  it('uses the built-in name for an app whose id does not read as words', () => {
    const action = describeServiceAction(
      facts({ toolkit: 'googlecalendar', operationSlug: 'GOOGLECALENDAR_DELETE_EVENT' })
    );
    expect(action.serviceName).toBe('Google Calendar');
    expect(action.actionName).toBe('Delete event');
  });

  it('names the account the way the Connections list does', () => {
    expect(describeServiceAction(facts({ connectionLabel: 'Work' })).accountLabel).toBe(
      'Work (work@acme.com)'
    );
    expect(describeServiceAction(facts({ connectionLabel: 'work@acme.com' })).accountLabel).toBe(
      'work@acme.com'
    );
    expect(describeServiceAction(facts({ identityHint: null })).accountLabel).toBe('gmail');
  });

  it('shortens long text to one line and never shows JSON', () => {
    const action = describeServiceAction(
      facts({
        arguments: {
          message_id: `line one\nline two ${'x'.repeat(300)}`,
          permanent: { nested: { deeper: true }, other: 1 },
          user_id: ['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com', 'i@j.com'],
        },
      })
    );
    const byLabel = Object.fromEntries(action.details.map((d) => [d.label, d.value]));
    expect(byLabel['Message ID']).toMatch(/^line one line two x+…$/u);
    expect(byLabel['Message ID']!.length).toBe(120);
    expect(byLabel['Permanent']).toBe('2 fields');
    expect(byLabel['User ID']).toBe('a@b.com, c@d.com, e@f.com and 2 more');
    for (const { value } of action.details) {
      expect(value).not.toMatch(/[{}[\]"]/u);
    }
    expect(ApprovalServiceActionSchema.safeParse(action).success).toBe(true);
  });

  it('counts a list of objects instead of showing it', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', user_id: [{ a: 1 }, { b: 2 }] } })
    );
    expect(action.details).toContainEqual({ label: 'User ID', value: '2 items' });
  });

  it('hides a secret-looking field and sweeps a token-shaped value', () => {
    const action = describeServiceAction(
      facts({
        arguments: { message_id: `id-${TOKEN}`, access_token: 'plain-secret', apiKey: 'k' },
      })
    );
    expect(action.details).toEqual([
      { label: 'Message ID', value: 'id-(hidden)' },
      { label: 'Access token', value: '(hidden)' },
      { label: 'API key', value: '(hidden)' },
    ]);
    expect(JSON.stringify(action)).not.toContain(TOKEN);
    expect(JSON.stringify(action)).not.toContain('plain-secret');
  });

  it('puts the action’s own fields first, so extra arguments cannot push them off', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`aaa_extra_${i}`, `value ${i}`])
    );
    const action = describeServiceAction(
      facts({ arguments: { ...extra, permanent: false, message_id: 'the-real-one' } })
    );
    expect(action.details.slice(0, 2)).toEqual([
      { label: 'Message ID', value: 'the-real-one' },
      { label: 'Permanent', value: 'No' },
    ]);
    expect(action.details).toHaveLength(6);
    expect(action.moreDetails).toBe(4);
  });

  it('strips punctuation from an argument name an agent chose', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', 'Account: boss@acme.com,': 'x', '!!!': 'y' } })
    );
    expect(action.details).toContainEqual({ label: 'Account boss acme com', value: 'x' });
    expect(action.details).toContainEqual({ label: 'Other', value: 'y' });
  });
});

describe('every argument stays readable (review round 1)', () => {
  const attendees = Array.from({ length: 12 }, (_, i) => ({
    email: `person${i + 1}@acme.com`,
    optional: i % 2 === 0,
  }));

  it('lists every item of a 12-attendee object list, indented, when the glance only counts it', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', user_id: attendees } })
    );
    expect(action.details).toContainEqual({ label: 'User ID', value: '12 items' });
    const lines = action.everything!;
    expect(lines[1]).toEqual({ label: 'User ID', value: '12 items', depth: 0 });
    for (let i = 1; i <= 12; i++) {
      expect(lines).toContainEqual({ label: 'Email', value: `person${i}@acme.com`, depth: 2 });
    }
    expect(lines.filter((line) => line.depth === 1)).toHaveLength(12);
    expect(action.everythingCut).toBeUndefined();
    for (const { value } of lines) expect(value).not.toMatch(/[{}[\]"]/u);
  });

  it('keeps a padded 130-character value whole in the complete list', () => {
    const padded = `${'pad '.repeat(30)}the decisive part`;
    expect(padded.length).toBeGreaterThan(130);
    const action = describeServiceAction(facts({ arguments: { message_id: padded } }));
    expect(action.details[0]!.value).toMatch(/…$/u);
    expect(action.everything).toContainEqual({ label: 'Message ID', value: padded, depth: 0 });
  });

  it('sends no complete list when the glance already shows everything whole', () => {
    expect(describeServiceAction(facts())).not.toHaveProperty('everything');
  });

  it('counts a value too long even for the complete list exactly once', () => {
    const action = describeServiceAction(facts({ arguments: { message_id: 'x'.repeat(20_001) } }));
    expect(action.everythingCut).toBe(1);
    expect(Array.from(action.everything![0]!.value)).toHaveLength(16_000);
  });

  it('counts labels in the budget and stops at 20,000 characters in all', () => {
    // 400 fields of 40-character values: with its label each line is over 50
    // characters, so the labels decide how many fit.
    const fields = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`field_number_${i}`, 'v'.repeat(40)])
    );
    const action = describeServiceAction(facts({ arguments: fields }));
    const lines = action.everything!;
    const used = lines.reduce((sum, line) => sum + line.label.length + line.value.length, 0);
    expect(used).toBeLessThanOrEqual(20_000);
    expect(lines.length + action.everythingCut!).toBe(400);
    expect(lines.length).toBeLessThan(20_000 / 50);
  });

  it('sweeps a token BEFORE shortening, so no fragment of it survives the cut', () => {
    const hex = 'a3f9c2e1b4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9';
    const value = `${'y'.repeat(100)}${hex}`;
    const action = describeServiceAction(facts({ arguments: { message_id: value } }));
    expect(action.details[0]!.value).toBe(`${'y'.repeat(100)}(hidden)`);
    expect(JSON.stringify(action)).not.toMatch(/a3f9c2e1/u);
  });

  it('cuts by whole characters, never leaving half an emoji', () => {
    const action = describeServiceAction(facts({ arguments: { message_id: '😀'.repeat(130) } }));
    const value = action.details[0]!.value;
    expect(value).toBe(`${'😀'.repeat(119)}…`);
    // No lone surrogate: every UTF-16 high half is followed by its low half.
    expect(value).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it('removes invisible direction and zero-width characters from values and the account', () => {
    const action = describeServiceAction(
      facts({
        connectionLabel: 'Wo‮rk',
        identityHint: 'me​@acme.com',
        arguments: { message_id: 'abc‮gpj.exe', user_id: 'z​w' },
      })
    );
    expect(action.accountLabel).toBe('Work (me@acme.com)');
    expect(action.details).toContainEqual({ label: 'Message ID', value: 'abcgpj.exe' });
    expect(action.details).toContainEqual({ label: 'User ID', value: 'zw' });
  });
});

describe('secrets never reach the card', () => {
  const shapes: Array<[string, string]> = [
    [
      'a JSON Web Token',
      fake(
        'ey',
        'JhbGciOiJIUzI1NiJ9',
        '.',
        'ey',
        'JzdWIiOiIxMjM0NTY3ODkwIn0',
        '.',
        'dozjgNryP4J3jVmNHl0w5N'
      ),
    ],
    ['an OpenAI key', fake('sk', '-', 'proj4bD9kLm2Qx7Rt5Vw8Yz1Ab3Cd')],
    ['an Anthropic key', fake('sk', '-', 'ant', '-', 'api03-Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh')],
    ['a GitHub token', fake('gh', 'p', '_', 'Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh8Ij')],
    ['a GitHub OAuth token', fake('gh', 'o', '_', 'Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh8Ij')],
    [
      'a GitHub fine-grained token',
      fake('github', '_pat', '_', '11ABCDEFG0123456789_abcdefghijklmnop'),
    ],
    ['a Slack token', fake('xo', 'xb', '-', '1234567890-0987654321-AbCdEfGhIjKl')],
    ['an AWS access key id', fake('AK', 'IA', 'IOSFODNN7EXAMPLE')],
    ['a long base64 key', 'Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh8Ij0Kl2Mn4Op6'],
  ];

  it.each(shapes)('hides %s wherever it appears in a value', (_name, secret) => {
    const action = describeServiceAction(
      facts({ arguments: { body: `note ${secret} end`, extra: [{ a: secret }] } })
    );
    expect(JSON.stringify(action)).not.toContain(secret);
    expect(action.details[0]!.value).toBe('note (hidden) end');
  });

  it.each([['Bearer'], ['Basic']])('hides a %s credential but keeps the word', (scheme) => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: `${scheme} dXNlcjpwYXNzd29yZA==` } })
    );
    expect(action.details[0]!.value).toBe(`${scheme} (hidden)`);
  });

  it.each([
    ['auth'],
    ['pwd'],
    ['passwd'],
    ['clientSecret'],
    ['api_key'],
    ['apiKey'],
    ['secret_key'],
    ['private_key'],
    ['access_key'],
    ['signingKey'],
    ['client_key'],
    ['session_token'],
    ['x-auth-header'],
  ])('hides the value of an argument named %s', (key) => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', [key]: 'plain-visible-value' } })
    );
    expect(JSON.stringify(action)).not.toContain('plain-visible-value');
  });

  it.each([
    ['issue_id_or_key'],
    ['Key'],
    ['primary_key'],
    ['idempotency_key'],
    ['session_id'],
    ['pass_through'],
    ['passenger'],
    ['keyboard'],
    ['author'],
  ])('keeps the value of an argument named %s readable', (key) => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', [key]: 'plain-visible-value' } })
    );
    expect(action.details.map((d) => d.value)).toContain('plain-visible-value');
  });

  it.each([
    ['a task runner command', 'npx task-runner-with-a-very-long-name --watch'],
    ['a desk booking slug', 'desk-booking-for-the-quarterly-planning-offsite'],
    ['settings words', 'Basic settings for the Bearer of this note'],
    ['a short Basic value', 'Basic abcdefgh'],
    ['a Drive file id', '1a2B3c4D5e6F7g8H9i0J-kLmNoPqRsTuVwXyZ_abcd1234'],
    ['a long mixed id with separators', 'Order_2026-09-28_AbCdEfGh1234_IjKlMnOp5678_QrStUv'],
    ['a shell command', 'git log --oneline -20 && pnpm vitest run apps/server'],
    ['a file path', '/Users/someone/Documents/Projects/Quarterly/Planning2026/notes.md'],
    ['a lower-case run', 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz'],
    ['a word ending in sk', 'task-a1'],
    ['a GitHub-ish word', fake('the-', 'gh', 'p', '_', ' marker is not a token')],
  ])('leaves %s readable', (_name, value) => {
    const action = describeServiceAction(facts({ arguments: { message_id: value } }));
    expect(action.details[0]!.value).toBe(value);
  });

  it.each([
    ['a Stripe live key', fake('sk', '_', 'live', '_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['a Stripe test key', fake('sk', '_', 'test', '_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['a Stripe restricted key', fake('rk', '_', 'live', '_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['a Stripe restricted test key', fake('rk', '_', 'test', '_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['a GitLab token', fake('gl', 'pat', '-', 'Zk9Lm2Qx7Rt5Vw8Yz1Ab')],
    ['a Google API key', fake('AI', 'za', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')],
    ['an npm token', fake('np', 'm', '_', 'Zk9Lm2Qx7Rt5Vw8Yz1Ab3Cd4Ef6Gh8Ij0Kl2')],
    ['a Slack app token', fake('xa', 'pp', '-', '1-A012345-1234567890-abcdef0123')],
  ])('hides %s', (_name, secret) => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'm', body: `use ${secret} here` } })
    );
    expect(JSON.stringify(action)).not.toContain(secret);
  });

  it.each([
    [fake('de', 'sk', '_', 'live', '_booking_for_the_whole_team')],
    [fake('xyz', 'AI', 'za', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')],
  ])('leaves %s readable when the prefix is inside a word', (value) => {
    const action = describeServiceAction(facts({ arguments: { body: value } }));
    expect(action.details[0]!.value).toBe(value);
  });

  describe('Google file ids stay readable', () => {
    const DRIVE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';

    it.each([['file_id'], ['spreadsheetId'], ['documentId']])(
      'keeps a separator-free id in %s',
      (key) => {
        const action = describeServiceAction(facts({ arguments: { [key]: DRIVE_ID } }));
        expect(action.details[0]!.value).toBe(DRIVE_ID);
      }
    );

    it('keeps the ids in a list named as ids, in the glance and the complete list', () => {
      const ids = [DRIVE_ID, DRIVE_ID, DRIVE_ID, DRIVE_ID];
      const action = describeServiceAction(facts({ arguments: { fileIds: ids } }));
      expect(action.details[0]!.value).toContain(DRIVE_ID);
      expect(action.everything).toContainEqual({ label: '1', value: DRIVE_ID, depth: 1 });
    });

    it('keeps the id in a Docs link inside a body', () => {
      const body = `See https://docs.google.com/document/d/${DRIVE_ID}/edit?usp=sharing please`;
      const action = describeServiceAction(facts({ arguments: { body } }));
      expect(action.everything ?? action.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: body })])
      );
    });

    it('still hides the same run in a body when it is not a path segment', () => {
      const action = describeServiceAction(facts({ arguments: { body: `copy ${DRIVE_ID} now` } }));
      expect(JSON.stringify(action)).not.toContain(DRIVE_ID);
    });

    it('still hides a key in a query string', () => {
      const body = `https://maps.example.com/api?key=${DRIVE_ID}&q=home`;
      const action = describeServiceAction(facts({ arguments: { body } }));
      expect(JSON.stringify(action)).not.toContain(DRIVE_ID);
    });

    it('still hides a token-shaped value in an id field', () => {
      const action = describeServiceAction(
        facts({ arguments: { file_id: fake('sk', '-', 'proj4bD9kLm2Qx7Rt5Vw8Yz1Ab3Cd') } })
      );
      expect(action.details[0]!.value).toBe('(hidden)');
    });
  });

  it('hides an Authorization header value whatever it looks like', () => {
    const action = describeServiceAction(
      facts({ arguments: { message_id: 'Authorization: Bearer abc' } })
    );
    expect(action.details[0]!.value).toBe('Authorization: Bearer (hidden)');
  });
});

describe('a destructive connected-app call raises a card that says what it does', () => {
  const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
  const CONNECTION_ID = 'connection-a';
  const REVISION_ID = 'revision-delete';
  /** The same action with a schema that lets undeclared arguments through. */
  const OPEN_REVISION_ID = 'revision-delete-open';
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    db = createDb(':memory:');
    runMigrations(db);
    const provider = new FakeConnectorProvider({
      instanceId: ConnectorProviderInstanceIdSchema.parse('provider-a'),
      type: 'fake',
    });
    const connectorRegistry = new ConnectorRegistry({ db });
    connectorRegistry.register(provider);
    db.update(connectorProviderInstances)
      .set({
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        executionConfigDigest: 'material-a',
        executionConfigGeneration: 1,
      })
      .where(eq(connectorProviderInstances.id, provider.instanceId))
      .run();
    db.insert(connections)
      .values({
        id: CONNECTION_ID,
        providerInstanceId: provider.instanceId,
        externalAccountRef: 'provider-account-a' as ConnectorExternalAccountRef,
        toolkit: 'gmail',
        label: 'Work',
        identityHint: 'work@acme.com',
        status: 'active',
        lifecycleState: 'connected',
        enabled: true,
        grantReconciliationStatus: 'ready',
        createdAt: '2026-09-28T12:00:00.000Z',
        updatedAt: '2026-09-28T12:00:00.000Z',
      })
      .run();
    const revisions = [
      { id: REVISION_ID, schema: DELETE_SCHEMA },
      { id: OPEN_REVISION_ID, schema: { ...DELETE_SCHEMA, additionalProperties: true } },
    ];
    db.insert(connectorOperationRevisions)
      .values(
        revisions.map(({ id, schema }) => ({
          id,
          providerInstanceId: provider.instanceId,
          toolkit: 'gmail',
          operationSlug: 'GMAIL_DELETE_MESSAGE',
          toolkitVersion: '2026-09-01',
          schemaHash: `sha256:${id}`,
          providerRevisionRef: `provider-${id}`,
          capabilityClassification: 'destructive' as const,
          retryPolicy: 'never' as const,
          inputSchemaJson: JSON.stringify(schema),
          discoveredAt: '2026-09-28T12:00:00.000Z',
        }))
      )
      .run();
    db.insert(connectionOperationGrants)
      .values(
        revisions.map(({ id }) => ({
          id: `grant-${id}`,
          subjectType: 'agent' as const,
          subjectId: 'agent-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: id,
          createdBy: 'operator',
          createdAt: '2026-09-28T12:00:00.000Z',
        }))
      )
      .run();
    approvals = new ApprovalService(db, {
      describeCapability: (id) => registry.get(id),
    });
    initCapabilityTierGate({ approvals });
    registry = composeRegistry([connectorExecutionDomain], {
      connectorExecutionDeps: {
        authorization: new ConnectorExecutionAuthorizationService(db, connectorRegistry, {
          ownsAgent: () => false,
        }),
        broker: {} as ConnectorExecutionBroker,
        access: {} as ConnectorAccessQueryService,
      },
    } as never);
  });

  afterEach(() => {
    resetCapabilityTierGate();
    vi.restoreAllMocks();
  });

  async function attempt(args: Record<string, unknown>, operationRevisionId = REVISION_ID) {
    const principal = createServerPrincipal({
      kind: 'agent',
      owner: OWNER,
      agentId: 'agent-a',
      agentPath: '/agents/agent-a',
    });
    const refusal = await registry
      .invoke(
        'connectors.execute_destructive',
        { connectionId: CONNECTION_ID, operationRevisionId, arguments: args },
        { serverPrincipal: principal }
      )
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(refusal).toBeInstanceOf(CapabilityGateRefusal);
    const [card] = approvals.listPending();
    expect(card).toBeDefined();
    return card!;
  }

  it('names the app, the account, the action and the arguments instead of two ids', async () => {
    const card = await attempt({ message_id: '18c2f0a9d1' });

    expect(card.serviceAction).toEqual({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
      details: [{ label: 'Message ID', value: '18c2f0a9d1' }],
    });
    expect(card.capabilityTitle).toBe('Take a high-risk action in a connected app');
    expect(card.summary).toBe(
      'An unidentified caller wants to run "Delete message" in Gmail on "Work (work@acme.com)" ' +
        'with Message ID: "18c2f0a9d1"'
    );
    expect(card.summary).not.toContain(CONNECTION_ID);
    expect(card.summary).not.toContain(REVISION_ID);
    // Nothing ran: the card is waiting on a person.
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('cannot be talked into naming a different app, account or action', async () => {
    // A value dressed as a header is still only a value.
    const dressed = await attempt({ message_id: 'Slack · personal@home.com · Read inbox' });
    expect(dressed.serviceAction).toMatchObject({
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
      details: [{ label: 'Message ID', value: 'Slack · personal@home.com · Read inbox' }],
    });
    expect(dressed.summary).toContain('Message ID: "Slack · personal@home.com · Read inbox"');
  });

  it('shows extra arguments an open schema lets through only as argument lines', async () => {
    const card = await attempt(
      {
        message_id: 'm-1',
        serviceName: 'Slack',
        serviceId: 'slack',
        accountLabel: 'personal@home.com',
        actionName: 'Read inbox',
      },
      OPEN_REVISION_ID
    );

    expect(card.serviceAction).toMatchObject({
      serviceId: 'gmail',
      serviceName: 'Gmail',
      accountLabel: 'Work (work@acme.com)',
      actionName: 'Delete message',
    });
    // The spoof arrives only as what it is: argument lines, after the action's
    // own field, never in the header.
    expect(card.serviceAction!.details[0]).toEqual({ label: 'Message ID', value: 'm-1' });
    expect(card.serviceAction!.details.slice(1)).toEqual([
      { label: 'Service name', value: 'Slack' },
      { label: 'Service ID', value: 'slack' },
      { label: 'Account label', value: 'personal@home.com' },
      { label: 'Action name', value: 'Read inbox' },
    ]);
    expect(card.summary).toMatch(/^An unidentified caller wants to run "Delete message" in Gmail/u);
  });
});
