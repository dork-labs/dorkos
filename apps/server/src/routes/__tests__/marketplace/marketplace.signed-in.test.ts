/**
 * @vitest-environment node
 *
 * With local login on, which callers count as the person: an API key is a
 * program (an agent inherits one legitimately), and a browser session clears
 * the bar but still needs the install owner's confirmation (DOR-4355).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The session gate lets every request through: these cases are about the
// routes' own bars, and each sets the user the gate would have proved.
vi.mock('../../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import { configManager } from '../../../services/core/config-manager.js';
import {
  enableLogin,
  installHeldBack,
  installWithKeptSkill,
  keepKeyOf,
  listSourceNames,
  uninstallResult,
  unprovenOnDisk,
  useMarketplaceRoutes,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

const API_KEY = { userId: 'user_program', credential: 'api-key' } as const;
const COOKIE = { userId: 'user_owner', credential: 'cookie' } as const;

beforeEach(() => {
  enableLogin();
});

describe('the tier gate on uninstall (DOR-474)', () => {
  beforeEach(() => {
    // Primed so a reopened gate answers a clean 200 rather than a 500.
    h.uninstallFlow.uninstall.mockResolvedValue(uninstallResult('demo-plugin'));
  });

  it('a caller holding only an API key gets an approval card, and nothing is removed', async () => {
    h.signedInUser = API_KEY;

    const res = await h.post('/packages/demo-plugin/uninstall', { purge: true });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('approval_required');
    expect(h.uninstallFlow.uninstall).not.toHaveBeenCalled();
  });

  it('the person with a session cookie is still not asked', async () => {
    // Without this, refusing everybody under login would look like a fix.
    h.signedInUser = COOKIE;

    const res = await h.post('/packages/demo-plugin/uninstall', {});

    expect(res.status).toBe(200);
    expect(h.uninstallFlow.uninstall).toHaveBeenCalled();
  });
});

describe('adding a source (DOR-3330)', () => {
  it('refuses a key, which is a program, and says where in the app to do it', async () => {
    // `dorkos marketplace add` presented a per-user API key and counted as the person.
    h.signedInUser = API_KEY;

    const refused = await h.post('/sources', {
      name: 'from-cli',
      source: 'https://example.com/from-cli',
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({
      error:
        'Adding a marketplace needs you signed in. In the DorkOS app, open Marketplace sources and click Add marketplace source.',
      code: 'marketplace_source_needs_app',
    });
    expect(await listSourceNames(h)).not.toContain('from-cli');
  });

  it('a browser session clears the bar, adding still needs the owner, and removing stays immediate', async () => {
    // Nobody owns this install, so the add is refused and nothing is added.
    h.signedInUser = COOKIE;

    const added = await h.post('/sources', {
      name: 'from-app',
      source: 'https://example.com/from-app',
    });
    expect(added.status).toBe(403);
    expect(added.body.code).toBe('NEEDS_PERSON_AT_THIS_COMPUTER');
    expect(await listSourceNames(h)).not.toContain('from-app');

    await h.sourceManager.add({ name: 'from-app', source: 'https://example.com/from-app' });
    expect((await h.del('/sources/from-app')).status).toBe(204);
    expect(await listSourceNames(h)).not.toContain('from-app');
  });
});

describe('deciding a held-back package (I-4)', () => {
  it('refuses a key and points it at the Review card, and a session still needs the owner', async () => {
    await installHeldBack(h.dorkHome, 'held');
    const [shown] = (await h.get('/held-back')).body.packages;
    const decide = () =>
      h.post('/held-back/held/decision', {
        decision: 'allow',
        effects: shown.effects,
        bindsTo: shown.bindsTo,
      });

    h.signedInUser = API_KEY;
    const byKey = await decide();
    expect(byKey.status).toBe(403);
    expect(byKey.body.code).toBe('operator_cookie_required');
    expect(byKey.body.error).toContain('press Review on the package');
    expect(
      (configManager.get('harness') as { approvedHooks?: string[] } | undefined)?.approvedHooks ??
        []
    ).toEqual([]);

    h.signedInUser = COOKIE;
    const bySession = await decide();
    expect(bySession.status).toBe(403);
    expect(bySession.body.code).toBe('NEEDS_PERSON_AT_THIS_COMPUTER');
    expect((await h.get('/held-back')).body.packages).toEqual([
      expect.objectContaining({ name: 'held' }),
    ]);
  });
});

describe('keeping files (DOR-2341)', () => {
  it('takes it only from a signed-in session, and a session still needs the owner', async () => {
    const root = await installWithKeptSkill(h.dorkHome);
    const keepKey = await keepKeyOf(h);
    const keep = () => h.post('/packages/flow/keep-files', { keepKey });

    h.signedInUser = API_KEY;
    const byKey = await keep();
    expect(byKey.status).toBe(403);
    expect(byKey.body.code).toBe('operator_cookie_required');
    expect(byKey.body.error).toContain('Keep these as mine');
    expect(await unprovenOnDisk(root)).toBeDefined();

    h.signedInUser = COOKIE;
    const bySession = await keep();
    expect(bySession.status).toBe(403);
    expect(bySession.body.code).toBe('NEEDS_PERSON_AT_THIS_COMPUTER');
    expect(await unprovenOnDisk(root)).toBeDefined();
  });
});
