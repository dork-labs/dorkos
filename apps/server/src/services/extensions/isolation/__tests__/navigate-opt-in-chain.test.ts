/**
 * The server half of the navigate opt-in, end to end (DOR-3293, Security
 * 2026-11-11): approve an app that lists a target as a plain id; its update
 * lists the target with `navigate: true`; that update does not run, and the
 * card comes back naming the target as new, with "can open its pages", until
 * a person says yes again. Until then the copy that runs is the approved one,
 * and opening the target's pages is `not-declared` under it. After the yes,
 * it is allowed (the window half, with its gesture, is
 * `features/extensions/__tests__/navigate-opt-in-chain.test.ts` in the client).
 *
 * The files digest is held the same on purpose, so this isolates the
 * permission-set rule: in real use an edited `extension.json` changes the
 * digest too, which asks again on its own (DOR-3068).
 */
import { describe, expect, it } from 'vitest';
import {
  decideAppNavigate,
  type ExtensionManifest,
  type ExtensionRecord,
} from '@dorkos/extension-api';
import { mayRunExtensionCode } from '../../extension-load-policy.js';
import { addedSince, declaredSet } from '../permission-coverage.js';
import { calledAppsView } from '../called-apps.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PATH = '/home/.dork/extensions/mkt-core';

const v1: ExtensionManifest = {
  id: 'mkt-core',
  name: 'Marketing core',
  version: '1.0.0',
  capabilities: { http: { apps: ['mkt-newsletter'] } },
};
const v2: ExtensionManifest = {
  ...v1,
  version: '1.1.0',
  capabilities: { http: { apps: [{ id: 'mkt-newsletter', navigate: true }] } },
};

/** The made-up target, which exports nothing. */
const newsletter = {
  manifest: { id: 'mkt-newsletter', name: 'Mkt Newsletter', version: '1.0.0' },
  status: 'active',
} as Pick<ExtensionRecord, 'manifest' | 'status'>;

const copyOf = (manifest: ExtensionManifest) => ({
  id: 'mkt-core',
  origin: 'user' as const,
  path: PATH,
  manifest,
  currentDigest: DIGEST,
});

/** A person's yes to `manifest`, as the approval records it. */
const yesTo = (manifest: ExtensionManifest) => ({
  approvedToRun: ['mkt-core'],
  approvedSources: { 'mkt-core': { path: PATH, digest: DIGEST } },
  approvedPermissions: { 'mkt-core': declaredSet(manifest) },
});

describe('approve, add navigate: true, ask again, then allow (Security, Nov 11)', () => {
  it('runs the plain-id copy, holds the update for a new yes, then lets it open pages', () => {
    const first = yesTo(v1);
    expect(mayRunExtensionCode(copyOf(v1), first)).toBe(true);
    // Under the approved copy, opening the target's pages is not declared.
    expect(
      decideAppNavigate({
        caller: v1,
        target: newsletter.manifest,
        targetId: 'mkt-newsletter',
        itemPath: '/issue/v-1',
      })
    ).toEqual({ ok: false, reason: 'not-declared' });

    // The update asks to open its pages: it does not run on the old yes…
    expect(mayRunExtensionCode(copyOf(v2), first)).toBe(false);
    // …and the card comes back, naming the target as new, opens only.
    expect(addedSince(declaredSet(v2), first.approvedPermissions['mkt-core'])?.apps).toEqual([
      'mkt-newsletter',
    ]);
    expect(calledAppsView({ id: 'mkt-core', manifest: v2 }, () => newsletter)).toEqual([
      { id: 'mkt-newsletter', name: 'Mkt Newsletter', access: null, opens: true },
    ]);

    // After the new yes it runs, and the rule allows opening the item's page.
    const second = yesTo(v2);
    expect(mayRunExtensionCode(copyOf(v2), second)).toBe(true);
    expect(
      decideAppNavigate({
        caller: v2,
        target: newsletter.manifest,
        targetId: 'mkt-newsletter',
        itemPath: '/issue/v-1',
      })
    ).toEqual({ ok: true });
  });
});
