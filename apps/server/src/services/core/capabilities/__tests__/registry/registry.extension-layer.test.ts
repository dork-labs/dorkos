import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EXTENSION_TOOL_UNAVAILABLE_MESSAGE } from '@dorkos/shared/capabilities';
import {
  defineCapability,
  composeRegistry,
  serializeCapability,
  CapabilityToolError,
  type ExtensionContribution,
  type ExtensionToolSpec,
} from '../../index.js';
import {
  buildExtensionDefinitions,
  checkExtensionContribution,
} from '../../extension-contribution.js';
import { deps, configGet, configDomain, extensionTool, contribution } from './registry.fixtures.js';

describe('extension layer — contribute and remove (DOR-2685)', () => {
  it('adds tools to get, capabilities and the catalog, and takes them away on remove', () => {
    // The whole point of the live layer: an extension's tools exist exactly
    // while it runs, and removing them leaves the catalog byte-identical,
    // version included, to what it was before.
    const registry = composeRegistry([configDomain], deps);
    const original = registry.catalog().catalogVersion;

    const result = registry.contribute(contribution('mail-app'));
    expect(result.ok).toBe(true);
    expect(registry.get('ext_mail_app.send_message')?.title).toBe('Tool send_message');
    const during = registry.catalog();
    expect(during.capabilities.map((c) => c.id)).toContain('ext_mail_app.send_message');
    expect(during.catalogVersion).not.toBe(original);

    if (result.ok) result.remove();
    expect(registry.get('ext_mail_app.send_message')).toBeUndefined();
    expect(registry.catalog().capabilities.map((c) => c.id)).toEqual([
      'config.get',
      'config.patch',
    ]);
    expect(registry.catalog().catalogVersion).toBe(original);
  });

  it('refuses an MCP tool name the core already claims, leaving the registry unchanged', () => {
    // An extension id can never collide with a core id (the ext_ prefix is
    // reserved), but a core capability's MCP tool name is free-form, so the
    // claim table must still be consulted.
    const squatter = defineCapability({
      id: 'probe.squat',
      title: 'Squat',
      description: 'Claims a tool name in the extension namespace.',
      tier: 'observe',
      area: null,
      input: z.object({}),
      output: z.unknown(),
      surfaces: { mcp: { toolName: 'ext_mail_app__send_message', servers: ['in-session'] } },
      invoke: async () => ({}),
    });
    const registry = composeRegistry([{ name: 'probe', capabilities: [squatter] }], deps);
    const before = registry.catalog().catalogVersion;

    const result = registry.contribute(
      contribution('mail-app', [extensionTool('archive'), extensionTool('send_message')])
    );

    expect(result).toEqual({ ok: false, reason: expect.stringContaining('already taken') });
    expect(registry.capabilities.map((c) => c.id)).toEqual(['probe.squat']);
    expect(registry.get('ext_mail_app.archive')).toBeUndefined();
    expect(registry.catalog().catalogVersion).toBe(before);
  });

  it('refuses any name that would make ext_<id>__<tool> readable two ways', () => {
    // `a--b` + `c` and `a` + `b__c` would both project to `ext_a__b__c`, so
    // whichever extension started first would own the other's name. Neither
    // half is allowed: no `--` or trailing `-` in the id, no `__` in a tool.
    const registry = composeRegistry([configDomain], deps);
    expect(registry.contribute(contribution('a--b', [extensionTool('c')])).ok).toBe(false);
    expect(registry.contribute(contribution('a', [extensionTool('b__c')])).ok).toBe(false);
    expect(registry.capabilities.map((c) => c.id)).toEqual(['config.get', 'config.patch']);
    expect(registry.contribute(contribution('a-b', [extensionTool('c_d')])).ok).toBe(true);
  });

  it('makes remove idempotent, and a stale handle cannot remove a newer contribution', () => {
    // Shutdown paths can overlap (a reload racing a disable); calling remove
    // twice, or on a handle from before a restart, must never take away the
    // tools the extension registered since.
    const registry = composeRegistry([configDomain], deps);
    const versions: number[] = [];
    registry.onChange((v) => versions.push(v));
    const first = registry.contribute(contribution('mail-app'));
    if (!first.ok) throw new Error('expected the first contribution to land');
    first.remove();
    first.remove();
    const second = registry.contribute(contribution('mail-app'));
    first.remove();

    expect(second.ok).toBe(true);
    expect(registry.get('ext_mail_app.send_message')).toBeDefined();
    expect(versions).toEqual([1, 2, 3]);
  });

  it('answers a removed extension tool with the plain not-available tool error', async () => {
    // An agent may still hold a tool list built while the extension ran; it
    // gets a sentence it can act on, not an internal "no capability" throw.
    const registry = composeRegistry([configDomain], deps);
    const result = registry.contribute(contribution('mail-app'));
    if (result.ok) result.remove();

    const error = await registry
      .invoke('ext_mail_app.send_message', { to: 'a@example.com' })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CapabilityToolError);
    expect((error as CapabilityToolError).payload).toEqual({
      error: EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
      code: 'EXTENSION_TOOL_UNAVAILABLE',
    });
    // A core id that does not exist keeps today's error.
    await expect(registry.invoke('config.nope', {})).rejects.not.toBeInstanceOf(
      CapabilityToolError
    );
  });
});

describe('extension layer — source on the catalog (DOR-2685)', () => {
  it('serializes source for an extension definition and omits it for a core one', () => {
    // Every reader of the catalog says where a tool came from off this field;
    // a core entry must stay exactly as it was, with no source key at all.
    const registry = composeRegistry([configDomain], deps);
    registry.contribute(contribution('mail-app'));

    expect(serializeCapability(configGet)).not.toHaveProperty('source');
    expect(
      registry.catalog().capabilities.find((c) => c.id === 'ext_mail_app.send_message')?.source
    ).toEqual({ kind: 'extension', id: 'mail-app', name: 'Ext mail-app' });
  });
});

describe('extension layer — reserved namespace (DOR-2685)', () => {
  it('refuses a core domain named in the ext_ namespace at boot', () => {
    // Otherwise a core domain could pre-claim an extension's ids, or an
    // extension's tools could be mistaken for core ones.
    expect(() => composeRegistry([{ name: 'ext_x', capabilities: [] }], deps)).toThrow(
      /reserved for extension tools/
    );
  });

  it('refuses a core capability that claims an extension source', () => {
    // `source` on the catalog must always mean what it says.
    const pretender = defineCapability({
      ...configGet,
      source: { kind: 'extension', id: 'mail-app', name: 'Mail' },
    });
    expect(() => composeRegistry([{ name: 'config', capabilities: [pretender] }], deps)).toThrow(
      /declares a source/
    );
  });
});

describe('extension layer — host-built definitions carry no privileged fields (DOR-2685)', () => {
  it('builds only the allowed keys, even from a spec smuggling privileged ones', () => {
    // An extension object is author-controlled. Whatever extra keys it
    // carries, the built definition has exactly these fields and no others:
    // no preflight, forwardsApproval, inSessionCard, approvalSubject,
    // areasForInput, describeApprovalChange, approvalDetailField, approvalView,
    // approvalViewDetail, approvalSentence.
    const smuggled = {
      ...extensionTool('send_message'),
      preflight: async () => ({}),
      forwardsApproval: true,
      inSessionCard: 'oauth',
      approvalSubject: { field: 'to', registry: 'agents' },
      areasForInput: () => ['permissions'],
      describeApprovalChange: async () => 'x',
      approvalDetailField: 'to',
      approvalView: () => ({}),
      approvalViewDetail: () => 'x',
      approvalSentence: () => 'wants to do nothing at all',
      cancelWindow: async () => async () => ({
        via: 'hold',
        holdId: 'x',
        authorityBindingDigest: 'x',
      }),
      areaNote: 'x',
      source: { kind: 'extension', id: 'someone-else', name: 'Spoof' },
      surfaces: { cli: { verb: 'x' }, http: { method: 'get', path: '/x' } },
    } as unknown as ExtensionToolSpec;
    const checked = checkExtensionContribution(contribution('mail-app', [smuggled]));
    if (!checked.ok) throw new Error(checked.reason);
    const [definition] = buildExtensionDefinitions(checked.value, 'extensions');

    expect(Object.keys(definition!).sort()).toEqual(
      [
        'approvalDisplayFields',
        'area',
        'description',
        'id',
        'input',
        'invoke',
        'output',
        'source',
        'surfaces',
        'tier',
        'title',
      ].sort()
    );
    expect(definition!.surfaces).toEqual({
      mcp: { toolName: 'ext_mail_app__send_message', servers: ['in-session'] },
    });
    expect(definition!.source).toEqual({ kind: 'extension', id: 'mail-app', name: 'Ext mail-app' });
  });

  it('refuses display fields the input lacks or that name a secret', () => {
    // A display field reaches the broadcast approval card.
    const missing = checkExtensionContribution(
      contribution('mail-app', [extensionTool('send', { approvalDisplayFields: ['nope'] })])
    );
    expect(missing.ok).toBe(false);
    const secret = checkExtensionContribution(
      contribution('mail-app', [
        extensionTool('send', {
          input: z.object({ apiToken: z.string() }),
          approvalDisplayFields: ['apiToken'],
        }),
      ])
    );
    expect(secret.ok).toBe(false);
  });

  it('never throws on hostile input, answering a refusal instead', () => {
    // contribute's contract is "never throws"; a getter that throws is the
    // sharpest version of a malformed contribution.
    const registry = composeRegistry([configDomain], deps);
    const hostile = {
      owner: 'mail-app',
      displayName: 'Mail',
      get tools(): never {
        throw new Error('gotcha');
      },
    } as unknown as ExtensionContribution;
    expect(registry.contribute(hostile)).toEqual({
      ok: false,
      reason: expect.stringContaining('gotcha'),
    });
    expect(registry.contribute(null as unknown as ExtensionContribution).ok).toBe(false);
  });
});
