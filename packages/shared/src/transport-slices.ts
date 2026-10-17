import type { FileSaveRecoveryTransport } from './file-save/recovery-transport.js';
/**
 * The slices of the {@link Transport} port kept in modules of their own (rooms,
 * community connections, remote communities, commitments, heartbeats, the first
 * run, message history, held connected-app actions, a hub's linked computers), joined here so
 * `transport.ts` extends one name. Nothing consuming the port sees a difference.
 *
 * @module shared/transport-slices
 */
import type { RoomTransport } from './transport-rooms.js';
import type { CommunityConnectionTransport } from './community-connections.js';
import type { RemoteCommunityTransport } from './community-views.js';
import type { CommitmentTransport } from './transport-commitments.js';
import type { ActivityTransport } from './transport-activity.js';
import type { AgentPauseTransport } from './transport-agent-pause.js';
import type { HeartbeatTransport } from './transport-heartbeats.js';
import type { RemoteAccessTransport } from './transport-remote-access.js';
import type { ComputerTransport } from './transport-computers.js';
import type { LocalBrowserTransport } from './transport-local-browser.js';
import type { OnboardingTransport } from './transport-onboarding.js';
import type { HistoryTransport } from './transport-history.js';
import type { ConnectorHoldTransport } from './transport-connector-holds.js';
import type { HubComputersTransport, SessionRelayTransport } from './transport-hub.js';

/** Every Transport slice declared outside `transport.ts`. */
export interface TransportSlices
  extends
    FileSaveRecoveryTransport,
    RoomTransport,
    CommunityConnectionTransport,
    RemoteCommunityTransport,
    CommitmentTransport,
    ActivityTransport,
    AgentPauseTransport,
    HeartbeatTransport,
    RemoteAccessTransport,
    OnboardingTransport,
    ComputerTransport,
    LocalBrowserTransport,
    HistoryTransport,
    ConnectorHoldTransport,
    HubComputersTransport,
    SessionRelayTransport {}
