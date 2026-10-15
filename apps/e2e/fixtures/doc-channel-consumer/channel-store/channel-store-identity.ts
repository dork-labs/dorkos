/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { requireOriginalConsumerInitial } from '../channel-store.js';
import { extendOriginalConsumerPhase } from './channel-store-phase-data.js';
/** Exact sequential original constructor phase; requires its inaccessible original key. */
export async function constructOriginalConsumerIdentity(ownerKey: object) {
  const context = requireOriginalConsumerInitial(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    resume,
    agents,
    sessionMetadata,
    runMigrations,
    eq,
    initAuth,
    readOwnerAccount,
    initConfigManager,
    ConnectorRuntimePrincipalService,
    setAgentHomeRegistry,
    docInstallationOwner,
    db,
  } = context;
  runMigrations(db); // Genuine current journal only: no fixture CREATE/DDL or synthesized native tables.
  initConfigManager(vault.root);
  const auth = initAuth(db, vault.root);
  // Create the real fresh local owner BEFORE capturing operator/grant authority.
  // Creating it afterwards would retire the captured local-install owner and
  // its generation/grants; account identity must never be silently borrowed.
  if (!resume)
    await auth.api.signUpEmail({
      body: {
        email: 'owner@consumer.invalid',
        password: 'temporary-consumer-password-123',
        name: 'Sanitized consumer owner',
      },
    });
  if (!readOwnerAccount()) throw new Error('Original native fixture owner account unavailable');
  const installationId = resume?.installationId ?? 'temporary-consumer-install',
    agentId = resume?.agentId ?? randomUUID(),
    sessionId = resume?.sessionId ?? randomUUID(),
    now = new Date().toISOString();
  const { writeManifest } = await import('@dorkos/shared/manifest');
  const { AgentManifestSchema } = await import('@dorkos/shared/mesh-schemas');
  const { seedAgentFace } = await import('@dorkos/shared/agent-face');
  if (!resume) {
    await writeManifest(
      vault.root,
      AgentManifestSchema.parse({
        id: agentId,
        name: 'sanitized-consumer-owner',
        description: 'Temporary consumer fixture',
        runtime: 'claude-code',
        capabilities: [],
        ...seedAgentFace(agentId),
        registeredAt: now,
        registeredBy: 'sanitized-consumer-fixture',
        personaEnabled: false,
        isSystem: false,
        mcpServers: [],
        workspace: { mode: 'home' },
      })
    );
    db.insert(agents)
      .values({
        id: agentId,
        name: 'Sanitized consumer owner',
        projectPath: vault.root,
        runtime: 'claude-code',
        status: 'active',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(sessionMetadata)
      .values({ sessionId, agentPath: vault.root, runtime: 'claude-code', createdAt: now })
      .run();
  } else {
    const { readManifest } = await import('@dorkos/shared/manifest');
    const manifest = await readManifest(vault.root);
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    const session = db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    if (
      !manifest ||
      manifest.id !== agentId ||
      manifest.runtime !== 'claude-code' ||
      !agent ||
      agent.status !== 'active' ||
      agent.projectPath !== vault.root ||
      agent.runtime !== 'claude-code' ||
      !session ||
      session.agentPath !== vault.root ||
      session.runtime !== 'claude-code'
    )
      throw new Error('Original native fixture identity changed before fresh boot');
  }
  if (hostBootstrap) {
    // Match original server boot: identity reads resolve only live registered
    // native homes, then read the actual on-disk manifest already checked above.
    setAgentHomeRegistry({
      isRegisteredHome: (path) =>
        db
          .select()
          .from(agents)
          .where(eq(agents.projectPath, path))
          .all()
          .some((agent) => agent.status === 'active'),
      listRegisteredHomes: () =>
        db
          .select()
          .from(agents)
          .where(eq(agents.status, 'active'))
          .all()
          .map((agent) => agent.projectPath),
      managedWorkspaceOwner: () => null, // This isolated fixture creates no managed workspace records.
      roomsDir: join(process.env.DORK_HOME ?? vault.root, 'rooms'),
    });
    context.agentHomeRegistryInstalled = true;
  }
  // Same original constructor and actual stored target validation as the native FILE fixture.
  // An actor supplied by page data never enters this factory.
  const principals = new ConnectorRuntimePrincipalService({
    db,
    authority: {
      authorizeTurn: async (input) => {
        const a = db.select().from(agents).where(eq(agents.id, agentId)).get();
        const target = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, input.canonicalSessionId))
          .get();
        if (
          !a ||
          a.status !== 'active' ||
          a.projectPath !== input.agentPath ||
          a.runtime !== input.runtime ||
          !target ||
          target.agentPath !== input.agentPath ||
          target.runtime !== input.runtime ||
          input.canonicalCwd !== vault.root
        )
          throw new Error('Original native target unavailable');
        return { owner: docInstallationOwner(installationId), agentId: a.id };
      },
      revalidateTurn: async (claims) => {
        const a = db.select().from(agents).where(eq(agents.id, claims.agentId)).get();
        const target = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, claims.canonicalSessionId))
          .get();
        return (
          !!a &&
          a.status === 'active' &&
          a.projectPath === claims.agentPath &&
          a.runtime === claims.runtime &&
          !!target &&
          target.agentPath === claims.agentPath &&
          target.runtime === claims.runtime &&
          JSON.stringify(docInstallationOwner(installationId)) === JSON.stringify(claims.owner)
        );
      },
    },
  });
  const boot = await principals.initializeBoot();
  return extendOriginalConsumerPhase(context, {
    auth,
    installationId,
    agentId,
    sessionId,
    now,
    writeManifest,
    AgentManifestSchema,
    seedAgentFace,
    principals,
    boot,
  });
}
