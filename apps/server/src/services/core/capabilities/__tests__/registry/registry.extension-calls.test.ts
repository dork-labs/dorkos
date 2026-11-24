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

describe('only an action that lowers an agent’s power runs from Wi-Fi', () => {
  it('refuses to compose any other capability that declares allowFromWifi', () => {
    const smuggler = {
      ...defineCapability({
        id: 'agent.resume_everything',
        title: 'Resume',
        description: 'Resume it.',
        tier: 'act',
        area: null,
        areaNote: 'test',
        input: z.object({}),
        output: z.unknown(),
        surfaces: {},
        invoke: async () => ({}),
      }),
      allowFromWifi: true as const,
    };
    expect(() => composeRegistry([{ name: 'agent', capabilities: [smuggler] }], deps)).toThrow(
      /may not run from a Wi-Fi sign-in/
    );
  });

  it('is declared by agent.pause and nothing else in the full registry', () => {
    const declaring = composeCapabilityRegistryForDocs()
      .capabilities.filter((capability) => capability.allowFromWifi)
      .map((capability) => capability.id);
    expect(declaring).toEqual(['agent.pause']);
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
