/** Internal peer-message admission and immutable room-seat scope (DOR-4472). */
import type {
  NewChatMessage,
  ChatMessageStore,
} from '../../session/chat-messages/chat-message-store.js';
import type { ChatSendReceipt } from '../../session/chat-messages/chat-message-service.js';
import type { AsideCarry } from '../room-trigger/aside.js';

/** A current binding, with its original ledger identity retained across native rekeys. */
export interface SeatMessageTarget {
  roomId: string;
  authorId: string;
  joinedAt: string;
  sessionId: string;
  agentPath: string;
  /** Server-verified native aliases for reply lookup only, never scope authority. */
  aliases?: readonly string[];
  /** Current binding used to verify runtime ownership after a native rename. */
  canonicalSessionId?: string;
  /** Server-owned bridge policy, including an archived/inactive bridge; grants no origin reach. */
  bridged: boolean;
  /** Current server-owned bridge correlated with this ledger seat; not an adoption receipt. */
  bridgeOwnership?: { bindingId: string; adapterId: string; chatId: string };
}

/** A server-created send, never an MCP/HTTP input shape. */
export interface SeatMessageAdmission {
  target: SeatMessageTarget;
  row: NewChatMessage;
  rendered: string;
  carried: AsideCarry;
}

/** One capacity-owned receipt; its original wait deadline survives retries. */
export interface SeatMessagePending extends SeatMessageAdmission {
  /** Derived only from the receipt classification committed by admission. */
  unsolicited: boolean;
  deadline: number;
}

/** The room-owned route a verified chat service may use. */
export interface RoomSeatMessagesPort {
  resolveSeatTarget(sessionId: string): SeatMessageTarget | null;
  admit(input: SeatMessageAdmission): ChatSendReceipt;
  recoverInterrupted(): number;
  stop(): void;
  idle(): Promise<void>;
}

/** Late boot composition, avoiding a runtime import cycle through the rooms barrel. */
export type RoomSeatMessageFactory = (
  store: ChatMessageStore,
  emit: (sessionId: string) => void
) => RoomSeatMessagesPort;
