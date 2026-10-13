import type { OpencodeClient } from '@opencode-ai/sdk';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import type { NativeSessionAcquisition } from '../../session/session-lock.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../canvas/doc-channel/current/current-operation-types.js';
import type { OpenConnectorTurnResult } from '../../connectors/runtime-principal-port.js';
import type { ConnectorTurnLeaseSupervisorHandle } from '../connectors/connector-turn-lease-supervisor.js';
import type { OpenCodeSidecarPlan } from './credits-sidecar.js';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';

import type { ConnectorRuntime } from '../../connectors/runtime-principal-port.js';
export type { OpenCodeRuntimeOptions } from './runtime-options.js';

/** Identity-matched original in-flight OpenCode turn DATA. */
export interface ActiveTurn {
  ocSessionId: string;
  cwd: string;
  controller: AbortController;
  phase: 'waiting' | 'setup' | 'running';
  connectorBinding?: OpenConnectorTurnResult;
  connectorSupervisor?: ConnectorTurnLeaseSupervisorHandle;
  connectorRevocation?: Promise<void>;
}

/** One turn that has started and is not yet tracked as active. Identity-compared. */
export interface SettingUpTurn {
  /** The session the turn belongs to. */
  sessionId: string;
}

/** Original OpenCodeNativeEntry row DATA; values are installed only by the actual runtime. */
export type OpenCodeNativeEntry = {
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
  acquisition?: NativeSessionAcquisition;
  instance: object;
  active: Map<string, ActiveTurn>;
  key: string;
  entry: ActiveTurn;
  signal: AbortSignal;
  retired: boolean;
  runtime: ConnectorRuntime;
  agentPath: string | undefined;
  cwd: string;
  client: OpencodeClient;
};

/** Original OpenCodePreparedRoomContinuation row DATA; values are installed only by the actual runtime. */
export type OpenCodePreparedRoomContinuation = {
  prepared: PreparedRoomResponder;
  committed: OriginalCommittedRoomResponder;
  turn: ActiveTurn;
  nativeOperation: object;
  nativeEntry: OpenCodeNativeEntry;
  plan: OpenCodeSidecarPlan;
  client: OpencodeClient;
  directory: string;
  retire: () => Promise<void>;
};

/** Exact original originalOpenCodeLockedStreams allocation data shape; this type issues no custody. */
export type OriginalOpenCodeLockedStreamData = {
  runtime: object;
  sessionId: string;
  options: Readonly<MessageOpts>;
  current(): boolean;
};

/** Exact original originalOpenCodeRoomStreams allocation data shape; this type issues no custody. */
export type OriginalOpenCodeRoomStreamData = {
  runtime: object;
  prepared: PreparedRoomResponder;
  operation: object;
  committed: OriginalCommittedRoomResponder;
  emitted: WeakSet<object>;
  close(): Promise<IteratorResult<StreamEvent, void>>;
  reason?: string;
  failed: boolean;
  done: boolean;
};

/** Exact original openCodeLockedRunners allocation data shape; this type issues no custody. */
export type OriginalOpenCodeLockedRunner = (
  sessionId: string,
  content: string,
  opts: MessageOpts | undefined,
  holder: SseResponse,
  lockKey: string
) => AsyncGenerator<StreamEvent>;

/** Exact original openCodeRoomPreparers allocation data shape; this type issues no custody. */
export type OriginalOpenCodeRoomPreparer = (
  source: OriginalFrozenRoomSource,
  holder: SseResponse,
  key: string
) => Promise<PreparedRoomResponder | undefined>;

/** Exact original openCodeRoomPrepared allocation data shape; this type issues no custody. */
export type OriginalOpenCodePreparedRoomData = {
  runtime: object;
  retire: () => Promise<void>;
  source: OriginalFrozenRoomSource;
  nativeOperation: object;
  acquisition: NativeSessionAcquisition;
  start: (committed: OriginalCommittedRoomResponder) => AsyncGenerator<StreamEvent>;
};
