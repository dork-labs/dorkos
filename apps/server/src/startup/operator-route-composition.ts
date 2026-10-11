import type { Application } from 'express';
import type { MeshCore } from '@dorkos/mesh';
import type { AuthorRegistry } from '../services/rooms/author-registry.js';
import type { RoomStore } from '../services/rooms/room-store.js';
import type { CapabilityRegistry } from '../services/core/capabilities/registry.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  readOwnerAccount,
  getUserById,
  setUserImage,
  setUserName,
} from '../services/core/auth/index.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { listRecentSessions } from '../services/session/index.js';
import { LocalAvatarStore } from '../services/identity/local-avatar-store.js';
import { resolveCaller } from '../routes/room-caller.js';
import { createTeamRouter } from '../routes/team.js';
import { createProfileRouter } from '../routes/profile.js';
import { createSearchRouter } from '../routes/search.js';
import { createTemplateRouter } from '../routes/templates.js';
import { createHarnessRouter } from '../routes/harness.js';
import { createApprovalsRouter } from '../routes/approvals.js';
import { createActivityRouter } from '../routes/activity.js';
import { createAuditRouter } from '../routes/audit.js';
import { createNotificationsRouter } from '../routes/notifications.js';
import { createPushRouter } from '../routes/push.js';
import { createExtensionDecisionsRouter } from '../routes/extension-decisions.js';

interface OperatorRouteComposition {
  dorkHome: string;
  roomAuthors: AuthorRegistry;
  roomStore: RoomStore;
  activeClaims: NonNullable<Parameters<typeof createTeamRouter>[0]['activeClaims']>;
  readMeshCore: () => MeshCore | undefined;
  approvalService: Parameters<typeof createApprovalsRouter>[0];
  activityService: Parameters<typeof createActivityRouter>[0];
  permissionService: NonNullable<Parameters<typeof createApprovalsRouter>[1]>['permissions'];
  auditLog: Parameters<typeof createAuditRouter>[0];
  notificationService: Parameters<typeof createNotificationsRouter>[0];
  pushSubscriptions: Parameters<typeof createPushRouter>[0]['subscriptions'];
  webPushChannel: Parameters<typeof createPushRouter>[0]['channel'];
  mountedRouters: string[];
  readCapabilityRegistry: () => CapabilityRegistry | undefined;
  db: Parameters<typeof createSearchRouter>[0]['db'];
}

/** Mount the original always-on operator surfaces in their unchanged relative order. */
export function mountOperatorRoutes(app: Application, deps: OperatorRouteComposition): void {
  const {
    dorkHome,
    roomAuthors,
    roomStore,
    activeClaims,
    readMeshCore,
    approvalService,
    activityService,
    permissionService,
    auditLog,
    notificationService,
    pushSubscriptions,
    webPushChannel,
    mountedRouters,
    readCapabilityRegistry,
    db,
  } = deps;
  // The team roster — one READ of every identity on this install (ADR
  // 260806-222535). Always mounted, and mounted even when the mesh did not
  // start: the person reading the page is on the roster, so a missing agent
  // registry is a `warnings[]` entry rather than a dead route.
  app.use(
    '/api/team',
    createTeamRouter({
      authors: roomAuthors,
      // `GET /api/team/:memberId/rooms` — where one member can be found (spec
      // `profile-unification` §3.2). The store rather than `RoomService`: this
      // is two membership reads and no room behaviour.
      rooms: roomStore,
      ...(readMeshCore() && { meshCore: readMeshCore() }),
      // What is working RIGHT NOW, from the one map that knows: the room
      // dispatcher's claims. Nothing else on this install can answer it.
      activeClaims: () => activeClaims(),
      // Archived included on purpose — a room can be archived while an agent is
      // still mid-turn in it, and the status sentence should still name it.
      listRooms: () =>
        roomStore
          .listRooms({ includeArchived: true })
          .map((room) => ({ id: room.id, name: room.title })),
      // When each agent last ran, for the agents mesh health cannot speak for
      // (it is stamped by the claude-code turn paths only). `limit: 1` because
      // only the `agentActivity` map is wanted here — it is computed across
      // every session before that trim, so the map is complete either way.
      sessionActivity: async () => {
        const { agentActivity } = await listRecentSessions({
          runtimes: runtimeRegistry.listRuntimes(),
          agentPaths: readMeshCore()
            ? readMeshCore()!
                .listWithPaths()
                .map((a) => a.projectPath)
            : [],
          limit: 1,
        });
        return agentActivity;
      },
      ownerAccount: () => readOwnerAccount(),
      ownerEmail: (userId) => getUserById(userId)?.email ?? null,
      // `config.profile.displayName` is what the user likes to be called — the
      // second rung of the operator-name precedence, under the account name.
      configDisplayName: () => configManager.getAll().profile.displayName,
      configDisplayNameSource: () => configManager.getAll().profile.displayNameSource,
      defaultAgentName: () => configManager.getAll().agents.defaultAgent,
    })
  );

  // The operator's own profile — their photo and their name (spec
  // `identity-consistency` §W3.3, §W3.5). The store is chosen HERE and nowhere
  // else: the router depends on the `AvatarStore` interface, so the day photos
  // live somewhere other than this machine, this line is what changes.
  app.use(
    '/api/profile',
    createProfileRouter({
      avatars: new LocalAvatarStore(dorkHome),
      caller: (req, res) => resolveCaller(req, res),
      authors: roomAuthors,
      ownerAccount: () => readOwnerAccount(),
      setAccountImage: (userId, imageUrl) => setUserImage(userId, imageUrl),
      setAccountName: (userId, name) => setUserName(userId, name),
      setProfileDisplayName: (displayName, source) => {
        const before = configManager.get('profile');
        // The name and the record of who wrote it go in ONE write, so no reader
        // can catch the new name still carrying the previous writer's stamp.
        // `set` rather than two `setDot`s for exactly that reason (DOR-1022);
        // WHICH source is the route's call, not this line's.
        configManager.set('profile', { ...before, displayName, displayNameSource: source });
        logConfigWrite('the profile route', 'profile', before, configManager.get('profile'));
      },
    })
  );

  // Message search — "where did we talk about X", over the derived index the
  // reconciler above keeps caught up (message-search spec §6, §7). Always
  // mounted and read-only. An install whose index is empty answers `[]`, which is
  // the honest answer and needs no flag; who may see what is resolved per request
  // through the rooms domain, never from this line.
  app.use('/api/search', createSearchRouter({ db }));

  // Template catalog — always available, merges built-in + user templates.
  app.use('/api/templates', createTemplateRouter(dorkHome));

  // Harness Sync — "what does every agent tool do with every agent file in this
  // project", and the Sync now button that acts on it. The GET writes nothing
  // (DOR-678's rule, stated in the route); the POST is person-only and takes
  // the project lock. The approval service is what lets the sync ask about a
  // package's hooks, exactly as the install path does.
  app.use('/api/harness', createHarnessRouter({ dorkHome, approvals: approvalService }));
  mountedRouters.push('harness');

  // Approvals — always available. The cockpit lists what is waiting on a person
  // and records their decision (spec `agent-trust` §3.3).
  // The test-only seam that seeds a request card reads it from here; production
  // mounts no test router, so nothing else does.
  app.locals.approvalService = approvalService;
  app.use(
    '/api/approvals',
    createApprovalsRouter(approvalService, {
      activity: activityService,
      // An "Always allow" writes through the one permission write owner, like
      // Settings does (spec `agent-permissions` D7).
      permissions: permissionService,
      // Names the action for the answer's audit line. Read lazily: the registry
      // is composed later in boot.
      describeCapability: (capabilityId) => readCapabilityRegistry()?.get(capabilityId),
    })
  );

  // Activity feed — always available, not behind a feature flag.
  app.use('/api/activity', createActivityRouter(activityService));
  app.use('/api/audit', createAuditRouter(auditLog));
  app.locals.activityService = activityService;
  mountedRouters.push('activity');

  // The Inbox — always available for the same reason: the history is written
  // whether or not any channel could carry it.
  app.use('/api/notifications', createNotificationsRouter(notificationService));
  mountedRouters.push('notifications');

  // Web push — how the escalation ladder reaches a browser DorkOS is not open
  // in. Always mounted: a person can subscribe a device before anything has ever
  // needed to escalate, and the routes are what tell the Settings tab whether
  // this install can push at all.
  app.use(
    '/api/push',
    createPushRouter({ subscriptions: pushSubscriptions, channel: webPushChannel })
  );
  mountedRouters.push('push');

  // The bell and the Activity inbox answer extension decisions here (spec
  // `flow-multiproject` §7.3). Always mounted: with no extension system it
  // simply lists nothing.
  app.use('/api/extension-decisions', createExtensionDecisionsRouter());
  mountedRouters.push('extension-decisions');
}
