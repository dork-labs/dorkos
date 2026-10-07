import { expect, it, onTestFinished } from 'vitest';
import { createDb, runMigrations, user, eq } from '@dorkos/db';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { CanonicalConnectorRuntimeAuthorityResolver } from '../../../connectors/principal/runtime-authority-resolver.js';
import { createBrowserRuntimeOwnerResolution } from '../runtime-owner-resolution.js';
/** Real authority/principal/DB/author implementations; controlled canonical
 * registry ports are unit subjects, not a native or model-execution receipt. */
async function original() {
  const db = createDb(':memory:');
  let active = true,
    login = true;
  const retained: { service?: ConnectorRuntimePrincipalService; binding?: string } = {};
  onTestFinished(async () => {
    active = false;
    try {
      if (retained.service && retained.binding)
        await retained.service.revoke(retained.binding, 'turn_terminal');
    } finally {
      db.$client.close();
    }
  });
  runMigrations(db);
  db.insert(user)
    .values({
      id: 'resolution-owner',
      name: 'Owner',
      email: 'resolution@fixture.invalid',
    })
    .run();
  const canonical = new CanonicalConnectorRuntimeAuthorityResolver({
    owner: {
      kind: 'local_install',
      installationId: 'resolution-original-installation',
    },
    sessions: {
      resolveSessionRuntime: async (id) => ({
        type: 'codex',
        bound: id === 'resolution-session',
      }),
      getSessionAgentPath: async (id) =>
        id === 'resolution-session' ? '/fixture/owner-agent' : null,
    },
    mesh: {
      getByPath: (path) =>
        path === '/fixture/owner-agent' ? { id: 'resolution-manifest' } : undefined,
    },
  });
  const service = (retained.service = new ConnectorRuntimePrincipalService({
    db,
    authority: canonical,
  }));
  await service.initializeBoot();
  const opened = await service.openTurn(
    {
      runtime: 'codex',
      canonicalSessionId: 'resolution-session',
      agentPath: '/fixture/owner-agent',
      canonicalCwd: '/fixture/owner-agent',
      signal: new AbortController().signal,
    },
    { isCurrent: () => active }
  );
  retained.binding = opened.bindingId;
  const resolved = await service.resolve({
    bearer: opened.bearer,
    expectedRuntime: 'codex',
    expectedCanonicalCwd: '/fixture/owner-agent',
  });
  if (resolved.status !== 'resolved') throw new Error('ORIGINAL_PRINCIPAL_REFUSED');
  const principal = resolved.principal,
    principals = service,
    authors = new AuthorRegistry(db);
  const owners = createBrowserRuntimeOwnerResolution({
    db,
    authors,
    installationId: 'resolution-original-installation',
    enabled: () => login,
  });
  return {
    db,
    principal,
    principals,
    authors,
    owners,
    disableLogin: () => {
      login = false;
    },
    revoke: () => {
      active = false;
    },
  };
}
it('canonical production local-install authority resolves only its real current account author and keeps original claims', async () => {
  const f = await original();
  const owner = f.owners.resolve(f.principal, () => f.principals.isPrincipalCurrent(f.principal));
  expect(owner?.accountId).toBe('resolution-owner');
  expect(owner?.authorId).toBe(f.authors.bindOwner('resolution-owner').id);
  expect(f.principal.claims.owner).toEqual({
    kind: 'local_install',
    installationId: 'resolution-original-installation',
  });
  expect(owner?.current()).toBe(true);
  f.disableLogin();
  expect(owner?.current()).toBe(false);
});
it('a structurally copied proof and a foreign canonical installation cannot acquire a browser owner', async () => {
  const f = await original();
  expect(f.owners.resolve({ ...f.principal }, () => true)).toBeUndefined();
  const foreign = createBrowserRuntimeOwnerResolution({
    db: f.db,
    authors: f.authors,
    installationId: 'foreign-installation',
    enabled: () => true,
  });
  expect(
    foreign.resolve(f.principal, () => f.principals.isPrincipalCurrent(f.principal))
  ).toBeUndefined();
});
it('later account replacement and genuine turn revocation both fence the original owner mapping', async () => {
  const f = await original(),
    owner = f.owners.resolve(f.principal, () => f.principals.isPrincipalCurrent(f.principal));
  expect(owner?.current()).toBe(true);
  f.db.delete(user).where(eq(user.id, 'resolution-owner')).run();
  f.db
    .insert(user)
    .values({
      id: 'resolution-replacement',
      name: 'Replacement',
      email: 'replacement-resolution@fixture.invalid',
    })
    .run();
  expect(owner?.current()).toBe(false);
  f.revoke();
  expect(
    f.owners.resolve(f.principal, () => f.principals.isPrincipalCurrent(f.principal))
  ).toBeUndefined();
});
