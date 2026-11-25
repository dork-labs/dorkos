import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineCapability, composeRegistry, type ExtensionToolSpec } from '../../index.js';
import { composeCapabilityRegistryForDocs } from '../../../self-description/dorkos-registry.js';
import {
  buildExtensionDefinitions,
  checkExtensionContribution,
} from '../../extension-contribution.js';
import { deps, extensionTool, contribution } from './registry.fixtures.js';

describe('tier presence is enforced by the type system', () => {
  it('rejects a definition missing its tier at compile time', () => {
    // @ts-expect-error — `tier` is required on every CapabilityDefinition.
    const invalid = defineCapability({
      id: 'config.notier',
      title: 'No tier',
      description: 'Missing tier.',
      input: z.object({}),
      output: z.object({}),
      surfaces: {},
      invoke: async () => ({}),
    });
    expect(invalid).toBeDefined();
  });
});

describe('extension layer — schemas every tool list can carry (DOR-2685 review)', () => {
  /** Whether a one-tool contribution with this input is accepted. */
  function accepts(input: z.ZodObject): boolean {
    return checkExtensionContribution(
      contribution('mail-app', [
        extensionTool('send', { tier: 'observe', input, approvalDisplayFields: undefined }),
      ])
    ).ok;
  }

  it('refuses inputs no tool list can carry and accepts an ordinary closed schema', () => {
    // A schema that cannot render as JSON Schema would throw the catalog for
    // everyone; one record anywhere in any in-session tool's input empties the
    // whole dorkos tool list on the current Claude SDK (tool-exposure.ts).
    expect(accepts(z.object({ when: z.date() }))).toBe(false);
    expect(accepts(z.object({ headers: z.record(z.string(), z.string()) }))).toBe(false);
    expect(accepts(z.object({ to: z.string() }).loose())).toBe(false);
    expect(accepts(z.object({ to: z.string(), mode: z.enum(['now', 'later']).optional() }))).toBe(
      true
    );
  });
});

describe('extension layer — author text on cards (DOR-2685 review)', () => {
  const titleOk = (title: string) =>
    checkExtensionContribution(contribution('mail-app', [extensionTool('send', { title })])).ok;
  const nameOk = (displayName: string) =>
    checkExtensionContribution({ ...contribution('mail-app'), displayName }).ok;

  it('refuses a title or display name that could forge or hide card text', () => {
    // A quote closes the card's quoted title; a newline fakes a second line; a
    // curly quote reads as a quote; an invisible character (zero-width, bidi
    // override) hides or reorders what a person reads.
    for (const title of ['Archive" with to: "me@x.com', 'Two\nlines', 'x'.repeat(81)]) {
      expect(titleOk(title), JSON.stringify(title)).toBe(false);
    }
    for (const ch of ['\u201c', '\u200b', '\u202e', '\ufeff']) {
      expect(titleOk(`Archive${ch}mail`), `title U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
      expect(nameOk(`Mail${ch}`), `name U+${ch.codePointAt(0)!.toString(16)}`).toBe(false);
    }
  });

  it('refuses a display name that looks like or claims to be DorkOS', () => {
    // "DоrkOS" with a Cyrillic о would read as DorkOS; "From DorkOS" would say
    // the tool is DorkOS's own.
    for (const displayName of ['D\u043erkOS', 'Dork OS', 'DorkBot']) {
      expect(nameOk(displayName), displayName).toBe(false);
    }
    expect(nameOk('Mail')).toBe(true);
  });
});

describe('extension layer — what an approval card shows (DOR-2685 review)', () => {
  it('requires card fields on act and destructive tools, as conformance does for core', () => {
    const check = (overrides: Partial<ExtensionToolSpec>) =>
      checkExtensionContribution(contribution('mail-app', [extensionTool('send', overrides)])).ok;
    // A card with no declaration shows every field; a destructive card with
    // none shows nothing for an irreversible action.
    expect(check({ tier: 'act', approvalDisplayFields: undefined })).toBe(false);
    expect(check({ tier: 'destructive', approvalDisplayFields: [] })).toBe(false);
    expect(check({ tier: 'destructive', input: z.object({}), approvalDisplayFields: [] })).toBe(
      false
    );
    // An act tool that takes no arguments has nothing to show.
    expect(check({ tier: 'act', input: z.object({}), approvalDisplayFields: [] })).toBe(true);
  });
});

describe('extension layer — the handler sees a narrowed call (DOR-2685 review)', () => {
  it('hands the handler who and where, never a proof object', async () => {
    // Trusted markers, principals, spent approvals and preflight bindings are
    // proofs other DorkOS code acts on; none of them reaches extension code.
    const seen: Record<string, unknown>[] = [];
    const checked = checkExtensionContribution(
      contribution('mail-app', [
        extensionTool('send', {
          invoke: async (_input, ctx) => {
            seen.push({ ...ctx });
            return {};
          },
        }),
      ])
    );
    if (!checked.ok) throw new Error(checked.reason);
    const [definition] = buildExtensionDefinitions(checked.value, 'extensions');
    const signal = new AbortController().signal;
    const full = {
      identity: { agentPath: '/agents/mailer', displayName: 'Mailer', createdAt: 'x' },
      sessionId: 's-1',
      cwd: '/work',
      signal,
      trusted: { marker: true },
      serverPrincipal: { principal: true },
      approval: { via: 'approval' },
      preflight: { authorityBinding: {} },
      approvalToken: 'secret-token',
      handTools: { has: () => true },
      userId: 'u-1',
    };
    await definition!.invoke(deps, { to: 'a' }, full as never);

    expect(seen).toEqual([
      { agent: { path: '/agents/mailer', name: 'Mailer' }, sessionId: 's-1', cwd: '/work', signal },
    ]);
  });
});

describe('only a reviewed list runs from Wi-Fi, each in its one mode (ADR 261125-114705)', () => {
  /** An `act` capability no list names, to smuggle a network mode onto. */
  function smuggler(id: `${string}.${string}`, surfaces: Record<string, unknown> = {}) {
    return defineCapability({
      id,
      title: 'Smuggle',
      description: 'Smuggle it.',
      tier: 'act',
      area: null,
      areaNote: 'test',
      input: z.object({}),
      output: z.unknown(),
      surfaces,
      invoke: async () => ({}),
    });
  }

  it('refuses to compose any other capability that declares a network mode', () => {
    for (const wifi of ['lowers-power', 'person-held'] as const) {
      const capability = { ...smuggler('agent.resume_everything'), wifi };
      expect(
        () => composeRegistry([{ name: 'agent', capabilities: [capability] }], deps),
        wifi
      ).toThrow(/may not run from a sign-in on your network/);
    }
  });

  it('refuses a listed id that declares the other mode', () => {
    const capability = { ...smuggler('agent.pause'), wifi: 'person-held' as const };
    expect(() => composeRegistry([{ name: 'agent', capabilities: [capability] }], deps)).toThrow(
      /may not run from a sign-in on your network/
    );
  });

  it('refuses person-held on a capability an agent may call', () => {
    const capability = {
      ...smuggler('todos.add_as_person', { http: { method: 'post', path: '/api/todos' } }),
      wifi: 'person-held' as const,
    };
    expect(() => composeRegistry([{ name: 'todos', capabilities: [capability] }], deps)).toThrow(
      /only a person may call it/
    );
  });

  it('pins the exact set of surfaces with any network mode: the pause, a person’s four to-do writes and the credits answer', () => {
    const declaring = composeCapabilityRegistryForDocs()
      .capabilities.filter((capability) => capability.wifi !== undefined)
      .map((capability) => [
        capability.id,
        capability.wifi,
        capability.surfaces.http?.method,
        capability.surfaces.http?.path,
        capability.surfaces.http?.audience,
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(declaring).toEqual([
      ['agent.pause', 'lowers-power', 'post', '/api/agents/{agentId}/pause', undefined],
      [
        'heartbeat.choose_triage_credits',
        'person-held',
        'put',
        '/api/heartbeats/triage-credits',
        'person',
      ],
      ['todos.add_as_person', 'person-held', 'post', '/api/todos', 'person'],
      ['todos.change_as_person', 'person-held', 'patch', '/api/todos/{id}', 'person'],
      ['todos.change_promise', 'person-held', 'patch', '/api/todo-promises/{id}', 'person'],
      ['todos.confirm_promise', 'person-held', 'post', '/api/todo-promises/{id}/confirm', 'person'],
    ]);
  });
});

describe('the cancel window is one action’s alone (spec trusted-by-default-flip §5.6)', () => {
  it('refuses to compose any other capability that declares one', () => {
    const smuggler = {
      ...defineCapability({
        id: 'config.wipe',
        title: 'Wipe config',
        description: 'Wipe it.',
        tier: 'destructive',
        area: null,
        areaNote: 'test',
        input: z.object({}),
        output: z.unknown(),
        surfaces: {},
        invoke: async () => ({}),
      }),
      cancelWindow: async () => undefined,
    };
    expect(() => composeRegistry([{ name: 'config', capabilities: [smuggler] }], deps)).toThrow(
      /may not declare a cancel window/
    );
  });

  it('is declared by connectors.execute_destructive and nothing else in the full registry', () => {
    const declaring = composeCapabilityRegistryForDocs()
      .capabilities.filter((capability) => capability.cancelWindow !== undefined)
      .map((capability) => capability.id);
    expect(declaring).toEqual(['connectors.execute_destructive']);
  });
});

describe('a confirm-first hold is a reviewed list’s alone (ADR 261125-114705, decision 4)', () => {
  /** A person-only capability no list names, to smuggle a hold onto. */
  function smuggler(audience?: 'person') {
    return {
      ...defineCapability({
        id: 'config.spend_everything',
        title: 'Spend',
        description: 'Spend it.',
        tier: 'act',
        area: null,
        areaNote: 'test',
        input: z.object({}),
        output: z.unknown(),
        surfaces: {
          http: { method: 'put', path: '/api/spend', ...(audience ? { audience } : {}) },
        },
        invoke: async () => ({}),
      }),
      confirmFirst: {
        kind: 'cloud.credits' as const,
        target: 'everything',
        reason: 'Spend everything.',
        accountOwner: { personOnly: 'Only you.', action: 'spend' },
      },
    };
  }

  it('refuses to compose any other capability that declares one', () => {
    expect(() =>
      composeRegistry([{ name: 'config', capabilities: [smuggler('person')] }], deps)
    ).toThrow(/may not declare a confirm-first hold/);
  });

  it('refuses a listed id that any agent may call', () => {
    const capability = { ...smuggler(), id: 'heartbeat.choose_triage_credits' as const };
    expect(() =>
      composeRegistry([{ name: 'heartbeat', capabilities: [capability] }], deps)
    ).toThrow(/only a person may call it/);
  });

  it('is declared by heartbeat.choose_triage_credits and nothing else in the full registry', () => {
    const declaring = composeCapabilityRegistryForDocs()
      .capabilities.filter((capability) => capability.confirmFirst !== undefined)
      .map((capability) => [capability.id, capability.confirmFirst?.kind]);
    expect(declaring).toEqual([['heartbeat.choose_triage_credits', 'cloud.credits']]);
  });
});
