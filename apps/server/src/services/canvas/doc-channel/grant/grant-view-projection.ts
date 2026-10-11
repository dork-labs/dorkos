import type {
  OriginalGrantRevalidationView,
  OriginalGrantCreationView,
} from './grant-private-views.js';
import type { OriginalGrantCustodyMaps } from './grant-original-custody-maps.js';
const originalGrantProjectionFreeze = Object.freeze;
const originalGrantProjectionApply = Reflect.apply;

/** Pure ordered getter projection; supplied DATA cannot register genuine grant membership. */
export function projectOriginalGrantRevalidationView(
  ports: Readonly<OriginalGrantRevalidationView>,
  maps: Readonly<OriginalGrantCustodyMaps>
): Readonly<OriginalGrantRevalidationView> {
  return originalGrantProjectionFreeze<OriginalGrantRevalidationView>({
    originalOwner: ports.originalOwner,
    get services() {
      return ports.services;
    },
    originalTokenPayloadValidate: ports.originalTokenPayloadValidate,
    get relayStore() {
      return ports.relayStore;
    },
    get tokenManifestReader() {
      return ports.tokenManifestReader;
    },
    get fixedServices() {
      return ports.fixedServices;
    },
    get fixedClaims() {
      return ports.fixedClaims;
    },
    privatePrepareTokenManifest: ports.privatePrepareTokenManifest,
    privatePrepareTokenCurrent: ports.privatePrepareTokenCurrent,
    privateReadTokenManifestOutsideSql: ports.privateReadTokenManifestOutsideSql,
    get now() {
      const run = ports.now;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get access() {
      const run = ports.access;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get refreshManifest() {
      const run = ports.refreshManifest;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get refreshAuthority() {
      const run = ports.refreshAuthority;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get refreshGrantedAuthority() {
      const run = ports.refreshGrantedAuthority;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get manifest() {
      const run = ports.manifest;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get suspend() {
      const run = ports.suspend;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get validateEventPayload() {
      const run = ports.validateEventPayload;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get revalidateGrant() {
      const run = ports.revalidateGrant;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get verifyCurrentGrant() {
      const run = ports.verifyCurrentGrant;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get revalidateOriginalWriteGrant() {
      const run = ports.revalidateOriginalWriteGrant;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get revalidateBatchGrant() {
      const run = ports.revalidateBatchGrant;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get getEffectiveLimits() {
      const run = ports.getEffectiveLimits;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    get getCurrentRoutes() {
      const run = ports.getCurrentRoutes;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    privateRelayRefresh: ports.privateRelayRefresh,
    privateRelayBatch: ports.privateRelayBatch,
    privateFixedNow: ports.privateFixedNow,
    privateFixedAccess: ports.privateFixedAccess,
    privateDocumentFinal: ports.privateDocumentFinal,
    privateDocumentDependencies: ports.privateDocumentDependencies,
    privateReplayRouting: ports.privateReplayRouting,
    privateSourceRows: ports.privateSourceRows,
    privatePrepareCurrent: ports.privatePrepareCurrent,
    privateAuditCurrent: ports.privateAuditCurrent,
    privateOriginalRoomSource: ports.privateOriginalRoomSource,
    privateReadCurrentChannel: ports.privateReadCurrentChannel,
    privateRefreshCurrentAuthority: ports.privateRefreshCurrentAuthority,
    ...maps,
  });
}

/** Pure ordered getter projection; supplied DATA cannot register genuine grant membership. */
export function projectOriginalGrantCreationView(
  ports: Readonly<OriginalGrantCreationView>,
  maps: Readonly<OriginalGrantCustodyMaps>
): Readonly<OriginalGrantCreationView> {
  return originalGrantProjectionFreeze<OriginalGrantCreationView>({
    originalOwner: ports.originalOwner,
    get store() {
      return ports.store;
    },
    get deps() {
      return ports.deps;
    },
    privateSuspendOriginalGrants: ports.privateSuspendOriginalGrants,
    privateRefreshOriginalAuthority: ports.privateRefreshOriginalAuthority,
    privateNow: ports.privateNow,
    privateAccess: ports.privateAccess,
    get configure() {
      const run = ports.configure;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    privateConfigure: ports.privateConfigure,
    get prepare() {
      const run = ports.prepare;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    privatePrepare: ports.privatePrepare,
    privateExisting: ports.privateExisting,
    get grant() {
      const run = ports.grant;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    privateGrant: ports.privateGrant,
    get revoke() {
      const run = ports.revoke;
      return (...args: Parameters<typeof run>): ReturnType<typeof run> =>
        originalGrantProjectionApply(run, ports.originalOwner, args);
    },
    privateRevoke: ports.privateRevoke,
    ...maps,
    PLATFORM_LIMITS: ports.PLATFORM_LIMITS,
    APPROVE_CAPABILITY: ports.APPROVE_CAPABILITY,
  });
}
