/**
 * The slices of the {@link Transport} port kept in modules of their own (rooms,
 * community connections, remote communities, commitments), joined here so
 * `transport.ts` extends one name. Nothing consuming the port sees a difference.
 *
 * @module shared/transport-slices
 */
import type { RoomTransport } from './transport-rooms.js';
import type { CommunityConnectionTransport } from './community-connections.js';
import type { RemoteCommunityTransport } from './community-views.js';
import type { CommitmentTransport } from './transport-commitments.js';

/** Every Transport slice declared outside `transport.ts`. */
export interface TransportSlices
  extends
    RoomTransport,
    CommunityConnectionTransport,
    RemoteCommunityTransport,
    CommitmentTransport {}
