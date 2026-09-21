/** Owner-scoped persistence for Community ordering and remembered destinations. */
import { CommunityRefSchema, type CommunityRef } from '@dorkos/shared/community-adapter';
import {
  CommunityNavigationStateSchema,
  communityNavigationForOwner,
  moveCommunityInOrder,
  reconcileCommunityNavigationOwner,
  rememberCommunityDestination,
  updateCommunityNavigationOwner,
  type CommunityNavigationState,
} from '@dorkos/shared/community-navigation';
import type {
  CommunityNavigationDestination,
  CommunityNavigationPrefs,
} from '@dorkos/shared/config-schema';
import type { ConfigManager } from '../core/config-manager.js';
import type { RemoteCommunityPairingService } from './remote/pairing-service.js';

/** Minimal room-authority probe used before restoring saved private navigation. */
export interface CommunityNavigationRoomAuthorizer {
  (ownerKey: string, ref: CommunityRef, roomId: string): Promise<boolean>;
}

/**
 * Serializes read-modify-write operations so two browser windows cannot replace
 * each other's ordering changes inside this server process.
 */
export class CommunityNavigationPreferenceService {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ConfigManager,
    private readonly connections: Pick<RemoteCommunityPairingService, 'list'>,
    private readonly canReadRoom: CommunityNavigationRoomAuthorizer
  ) {}

  /** Read current owner state after pruning refs absent from the authoritative connection list. */
  async get(ownerKey: string): Promise<CommunityNavigationState> {
    return this.serialized(async () => {
      const refs = await this.authorizedRefs(ownerKey);
      const prefs = this.config.get('ui').communityNavigation;
      const next = reconcileCommunityNavigationOwner(prefs, ownerKey, refs);
      this.persistIfChanged(prefs, next);
      return this.publicState(next, ownerKey);
    });
  }

  /** Apply one relative move to the latest stored order. */
  async move(
    ownerKey: string,
    ref: CommunityRef,
    direction: 'up' | 'down'
  ): Promise<CommunityNavigationState> {
    return this.serialized(async () => {
      const refs = await this.authorizedRefs(ownerKey);
      const prefs = this.config.get('ui').communityNavigation;
      const next = moveCommunityInOrder(prefs, ownerKey, ref, direction, refs);
      this.persistIfChanged(prefs, next);
      return this.publicState(next, ownerKey);
    });
  }

  /** Save one destination only while its connection and room remain authorized. */
  async remember(
    ownerKey: string,
    destination: CommunityNavigationDestination
  ): Promise<CommunityNavigationState> {
    return this.serialized(async () => {
      const refs = await this.authorizedRefs(ownerKey);
      const prefs = this.config.get('ui').communityNavigation;
      let next = reconcileCommunityNavigationOwner(prefs, ownerKey, refs);
      if (
        refs.includes(destination.ref) &&
        (await this.canReadRoom(
          ownerKey,
          CommunityRefSchema.parse(destination.ref),
          destination.roomId
        ))
      ) {
        next = rememberCommunityDestination(next, ownerKey, destination);
      }
      this.persistIfChanged(prefs, next);
      return this.publicState(next, ownerKey);
    });
  }

  /** Resolve one destination after rechecking both connection and room authority. */
  async resolve(
    ownerKey: string,
    ref: CommunityRef
  ): Promise<CommunityNavigationDestination | null> {
    return this.serialized(async () => {
      const refs = await this.authorizedRefs(ownerKey);
      const prefs = this.config.get('ui').communityNavigation;
      let next = reconcileCommunityNavigationOwner(prefs, ownerKey, refs);
      const destination = communityNavigationForOwner(next, ownerKey).destinations.find(
        (saved) => saved.ref === ref
      );
      if (destination && (await this.canReadRoom(ownerKey, ref, destination.roomId))) {
        this.persistIfChanged(prefs, next);
        return destination;
      }
      if (destination) {
        next = updateCommunityNavigationOwner(next, ownerKey, (owner) => ({
          ...owner,
          destinations: owner.destinations.filter((saved) => saved.ref !== ref),
        }));
      }
      this.persistIfChanged(prefs, next);
      return null;
    });
  }

  private async authorizedRefs(ownerKey: string): Promise<string[]> {
    return (await this.connections.list(ownerKey))
      .filter((connection) => connection.status !== 'pending')
      .map((connection) => connection.ref);
  }

  private publicState(prefs: CommunityNavigationPrefs, ownerKey: string): CommunityNavigationState {
    const owner = communityNavigationForOwner(prefs, ownerKey);
    return CommunityNavigationStateSchema.parse({
      ownerKey,
      order: owner.order,
      destinations: owner.destinations,
    });
  }

  private persistIfChanged(
    previous: CommunityNavigationPrefs,
    next: CommunityNavigationPrefs
  ): void {
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.config.set('ui', { ...this.config.get('ui'), communityNavigation: next });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation, operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
