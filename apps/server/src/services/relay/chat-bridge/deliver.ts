/**
 * The outbound half of the bridge: a committed room entry is delivered back to
 * the platform chat it projects into (chats-as-channels spec §6). This is the
 * counterpart to `ingest.ts` and the piece that closes the loop — a room post
 * now reaches the person on Telegram.
 *
 * **Delivery is driven off the durable room log, never off the live stream.**
 * `publishEntry` → `RoomBroadcaster` (`room-stream.ts`) drops events for absent
 * subscribers, so a bridge subscribed to it would silently lose every entry
 * committed while the adapter was down. Instead there are two drivers, and the
 * scan is the authority:
 *
 * - the INLINE fast path ({@link ChatBridgeDelivery.onCommit}) attempts delivery
 *   the instant an entry commits, so a live chat answers promptly; and
 * - the CATCH-UP scan (`catch-up.ts`, which calls {@link ChatBridgeDelivery.deliverEntry})
 *   walks the log for undelivered entries on start, on adapter reconnect, and
 *   after a delivery failure resolves.
 *
 * Idempotence and exactly-once come from the external-ref table (spec §6.3), not
 * from either driver running at most once: {@link ChatBridgeDelivery.deliverEntry}
 * is serialized per `(adapterId, chatId)` and no-ops on an entry that already
 * carries a ref, so the inline attempt and a scan racing the same entry resolve
 * to one send.
 *
 * **Echo suppression is the external-ref table and nothing else** (spec §6.3) —
 * no text compare, no time window, no recently-sent cache. An entry `ingest`
 * wrote carries an `inbound` ref, and {@link ChatBridgeDelivery.deliverEntry}
 * skips any entry that already has a ref of either direction. That single
 * structural check answers both "never round-trip an inbound message" (A6.1) and
 * "a retry sends nothing" (A6.2).
 *
 * **Write-before-send** (spec §6.3): the `outbound` ref is written BEFORE the
 * platform call, with a null platform id patched in after the send returns. A
 * crash between the write and the send therefore yields a SUPPRESSED RETRY (an
 * entry that looks delivered and is not — visible in the room, recoverable) and
 * never a DUPLICATE (a message a person sees twice — not recallable). We fail on
 * the suppressed side. A send this code KNOWS did not land — the consent gate
 * refused it, or the retry budget was exhausted — rolls its ref back
 * ({@link BridgeStore.deleteOutboundRef}) so the catch-up scan can re-deliver it;
 * a crash cannot reach that rollback, so its ref survives and idempotence
 * suppresses the retry.
 *
 * **The suppressed retry must still not be SILENT (spec §10.1, DOR-898).** A
 * crash-stranded null-id ref is invisible to {@link BridgeStore.listUndeliveredAboveSeq}
 * — it has a ref, full stop, so the catch-up scan's candidate query excludes
 * it exactly like a delivered entry — and nothing else in the running process
 * ever revisits it. {@link ChatBridgeDelivery.sweepStrandedRefs} is the fix,
 * run once at startup: it finds every null-id outbound ref old enough that it
 * cannot still be a legitimate in-flight retry, and posts the same
 * `bridge_undelivered` notice the exhausted-retry path already writes. It
 * deliberately does NOT roll the ref back or re-send — the crashed send may
 * have actually reached the platform before the process died, and re-sending
 * on that guess risks the one outcome this whole design exists to avoid, a
 * message a person sees twice. The notice makes the stranded case legible; a
 * human (or a later explicit action) decides what happens to the message.
 *
 * @module server/services/relay/chat-bridge/deliver
 */
import type { PublishOptions, PublishResult } from '@dorkos/relay';
import type { RoomEntry, RoomEntryBody, RoomNoticeCode } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { AuthorRecord } from '../../rooms/author-registry.js';
import {
  bridgeTurnFailedText,
  bridgeWaitingText,
  buildBridgeBlockedNotice,
  buildBridgeUndeliveredNotice,
  type BridgeBlockedReason,
} from '../../rooms/notices/notice-copy.js';
import { buildBridgePrincipal, type BridgePrincipalClassification } from '../bridge-principal.js';
import type { Bridge, BridgeStore, ExternalRef } from './bridge-store.js';

/**
 * The room notices a bridge delivers when `deliverNotices` is on (spec §6.2).
 *
 * The test is one question: **would a person on the far end otherwise be left
 * watching an agent that has stopped, with nothing to tell them it has?** Four
 * codes answer yes.
 *
 * - `turn_failed` — the turn ran and broke. Re-rendered for the chat
 *   ({@link ChatBridgeDelivery.buildNoticeContent}).
 * - `halted` — somebody stopped everything running in the room.
 * - `awaiting_approval` — the turn stopped and is parked on a person (DOR-1359).
 * - `agent_busy` — the agent was already working, so no turn ran at all
 *   (DOR-1359).
 *
 * **The last two were excluded, and the exclusion was the bug.** Spec §6.2
 * called every remaining notice "cockpit-shaped", which is true of
 * `cascade_stopped` and `budget_reached` (they describe this install's own
 * limits) and true of `agent_gone` and `agent_unavailable` (they name a
 * registration and a database the platform person has no relationship with and
 * cannot act on). It was not true of these two: both describe an agent that has
 * STOPPED, and both are exactly what somebody on Telegram is missing while they
 * wait for an answer that is never coming. Until DOR-1359 they learned nothing.
 *
 * **`agent_busy` forwards the room's stored words; `awaiting_approval` is
 * re-rendered.** The room's own waiting line ends "open its session to answer",
 * which points a bridged reader at a door they may not have, so the far end
 * gets its own sentence per kind ({@link ChatBridgeDelivery.buildNoticeContent},
 * `notice-copy.ts`'s `bridgeWaitingText`). Both stay deliberately vague, late
 * and damped: no tool name, path or command, which is what keeps one member's
 * approval decision out of a shared chat (DOR-613).
 *
 * **A chat CAN now answer the Ask, and that is why this notice is sometimes
 * skipped.** DOR-1356 gives an allowlisted approver on a bridged PRIVATE chat a
 * real Approve/Deny card (`ask-card.ts`, gated by `mayApprove` through
 * `askEntitlement`). Where a card is standing for that agent, the sentence
 * behind it would be a near-duplicate a minute late, so it is not delivered —
 * see {@link ChatBridgeDeliveryDeps.asks}. The room's own entry is written
 * either way; only its delivery is suppressed.
 *
 * **`agent_busy` carries its own damper, `awaiting_approval` does not, and the
 * asymmetry is measured rather than assumed.** `RoomNoticeLog.reportWaiting`
 * damps a waiting line per `(room, agent)` for the life of the turn with no
 * exception, so one wait is already one room entry. `reportSilence` damps the
 * busy line the same way EXCEPT for a message that directly asked the agent —
 * and in a `dm` that is every message a person types, which is exactly what a
 * bridged private chat is. Three messages in one breath at an agent busy
 * elsewhere therefore write three room notices. The room is right to; a phone
 * buzzing three times is not, so the bridge damps it itself
 * ({@link ChatBridgeDelivery.busyIsARepeat}).
 */
const DELIVERABLE_NOTICES: ReadonlySet<RoomNoticeCode> = new Set<RoomNoticeCode>([
  'turn_failed',
  'halted',
  'awaiting_approval',
  'agent_busy',
]);

/**
 * How long a bridge notice (`bridge_blocked`, `bridge_undelivered`) stays quiet
 * in one room after it fires, so a run of blocked or failed deliveries produces
 * one line per reason rather than one per entry (spec §6.6, §10.1). Matches the
 * ingest rate-notice damper.
 */
const NOTICE_DAMP_MS = 10 * 60_000;

/**
 * The waits, in milliseconds, before each retry of a failed send (spec §10.1:
 * "3 attempts, exponential, ≤ 2 min"). Two entries here means three attempts
 * total — the initial send plus two retries — both under the two-minute ceiling.
 * A 429 overrides the wait with the platform's own `retry_after` (spec §10.2)
 * but still spends against this budget.
 */
const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [2_000, 30_000];

/**
 * How old a null-platform-id outbound ref must be before
 * {@link ChatBridgeDelivery.sweepStrandedRefs} (DOR-898, spec §10.1's crash
 * divergence) treats it as a stranded crash victim rather than a plausibly
 * in-flight retry. The retry ladder itself is capped at "≤ 2 min" (spec
 * §10.1) — `attemptDelivery` settles every send (delivered, blocked, rolled
 * back, or archived) well inside that ceiling — so this threshold adds a wide
 * margin on top of it. A ref this old was never going to settle; the process
 * that owned it is gone.
 */
export const STRANDED_OUTBOUND_REF_THRESHOLD_MS = 10 * 60_000;

/**
 * The wire label an operator-authored post is prefixed with (spec §6.7) when
 * no real name is configured ({@link ChatBridgeDeliveryDeps.operatorDisplayName}
 * resolves `null`). Deliberately not `'You'`: that word only reads correctly
 * from the operator's own cockpit seat, and a bridged group has no such seat
 * (DOR-899). Neutral rather than invented — nothing here knows the person's
 * name, so this says what IS known (somebody is operating this install)
 * instead of guessing at who.
 */
const OPERATOR_FALLBACK_LABEL = 'Operator';

/** The outcome of one {@link ChatBridgeDelivery.deliverEntry}. */
export type DeliverOutcome =
  /** Sent to the chat; the outbound ref now carries the platform message id. */
  | 'delivered'
  /** Refused by the reply/initiate consent gate; a `bridge_blocked` notice was written. */
  | 'blocked'
  /** The retry budget was exhausted; the ref was rolled back and a `bridge_undelivered` notice written. */
  | 'undelivered'
  /** A 403 (bot blocked/kicked/chat gone); the room was archived (spec §10.3). */
  | 'terminal'
  /** The entry came FROM the chat (an `inbound` ref) — never sent back (echo suppression). */
  | 'echo'
  /** The entry already has an `outbound` ref — a no-op retry (idempotence). */
  | 'noop'
  /** Not a delivery candidate: an undeliverable notice, or a kind that never delivers. */
  | 'skipped'
  /**
   * A repeat of a state the chat has already been told about — today only
   * `agent_busy` (DOR-1359). Settled, not stopped: it will never become
   * deliverable on a later pass, so the catch-up cursor moves past it.
   */
  | 'damped'
  /** A post whose author is neither the bound agent nor the operator — refused before any publish. */
  | 'refused_author'
  /** The room has no live bridge. */
  | 'no_bridge';

/** Read one entry by id — {@link RoomStore.getEntryById}. */
export interface DeliverEntryReader {
  /**
   * One entry by its stable id, scoped to the room — `null` when the id names
   * no entry IN THIS ROOM, which is exactly how provenance stays room-scoped
   * (a cross-room cascade root reads as `null` here and classifies as an
   * initiate, spec §6.6).
   *
   * @param roomId - The room to read within.
   * @param entryId - The entry id.
   */
  getEntryById(roomId: string, entryId: string): RoomEntry | null;
}

/** Write the room's own voice — {@link RoomService.postNotice}. */
export interface DeliverNoticeWriter {
  /**
   * Write a `notice` entry as the room's own voice.
   *
   * @param roomId - The room.
   * @param body - The notice body.
   * @returns The written entry; only its `id` is read here.
   */
  postNotice(roomId: string, body: RoomEntryBody): { id: string };
}

/** Resolve an author row by id — {@link AuthorRegistry.getById}. */
export interface DeliverAuthorReader {
  /**
   * The stored author for an id, or nullish when none — used for the
   * delivering-author check (spec §6.6 step 2) and the author-name prefix
   * (spec §6.7).
   *
   * @param authorId - The author id.
   */
  getById(authorId: string): AuthorRecord | null | undefined;
}

/** Publish to the relay bus — {@link RelayCore.publish}. */
export interface DeliverPublisher {
  /**
   * Publish an outbound message. The consent gate runs INSIDE this pipeline and
   * a refused publish comes back as `rejected: [{ reason: 'initiate_denied' }]`
   * — it does not throw (spec §6.6).
   *
   * @param subject - The chat's `relay.human.*` subject.
   * @param payload - The message payload (content plus optional reply/topic targeting).
   * @param options - Publish options; `from` carries the bridge principal.
   */
  publish(subject: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
}

/** Whether a bridged Ask card is standing, so its waiting sentence is redundant. */
export interface StandingAskCards {
  /**
   * Whether a card this process sent is still standing for one room's agent.
   *
   * @param roomId - The room the notice is about.
   * @param authorId - The agent the notice is about (`subjectAuthorId`).
   */
  hasStandingCard(roomId: string, authorId: string | undefined): boolean;
}

/** Archive a bridge on a terminal delivery failure — {@link BridgeLifecycle.unbridge}. */
export interface DeliverLifecycle {
  /**
   * Switch a binding's bridge off and archive its room, recording the platform's
   * own reason (spec §3.5, §10.3).
   *
   * @param bindingId - The binding whose bridge to archive.
   * @param opts.reason - The platform's own words for a forced disconnect.
   */
  unbridge(bindingId: string, opts?: { reason?: string }): Promise<void>;
}

/** Everything {@link ChatBridgeDelivery} is constructed from. */
export interface ChatBridgeDeliveryDeps {
  /** Read entries by id, for provenance and reply targeting. */
  entries: DeliverEntryReader;
  /** Write bridge notices in the room's own voice. */
  rooms: DeliverNoticeWriter;
  /** The bridge identity and external-ref store (spec §3.1, §6.3). */
  bridges: BridgeStore;
  /** Resolve authors, for the delivering-author check and the name prefix. */
  authors: DeliverAuthorReader;
  /** Publish to the relay bus — the gate runs inside it. */
  publisher: DeliverPublisher;
  /** Archive a bridge on a terminal (403) failure. */
  lifecycle: DeliverLifecycle;
  /**
   * Build the chat's `relay.human.*` subject from its bridge row. Injected
   * rather than derived here because the platform segment lives on the adapter,
   * not on the bridge row; production wires it from the adapter's own codec.
   * Returns `null` when the subject cannot be built, which refuses delivery
   * rather than guessing.
   */
  resolveSubject: (bridge: Bridge) => string | null;
  /** The install owner's author id — one of the two authors allowed to deliver (spec §6.6). */
  operatorAuthorId: () => string;
  /**
   * The REAL name to prefix an operator-authored post with on the wire (spec
   * §6.7), or `null` when nothing is configured. Resolved per call, like
   * {@link ChatBridgeDeliveryDeps.operatorAuthorId} — the person can set or
   * change it at any time. Optional; a caller that omits it gets a delivery
   * that always falls back to {@link OPERATOR_FALLBACK_LABEL}, which is the
   * safe default for a test or an early wiring that has not threaded one.
   *
   * **NEVER the author row's cached `displayName`.** `author-registry.ts`
   * fixes that at `'You'` on purpose — the right word for the operator's OWN
   * cockpit seat, and exactly the identity confusion the §6.7 prefix exists
   * to prevent when it is the word a bridged group reads instead (DOR-899).
   */
  operatorDisplayName?: () => string | null;
  /** Clock, injectable so activity stamps and the notice damper are testable. */
  now?: () => number;
  /** Sleep between retries, injectable so the failure ladder does not really wait in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The retry backoff schedule (spec §10.1); overridable for tests. */
  retryBackoffMs?: readonly number[];
  /**
   * Whether an Approve/Deny card is already standing in this chat for the agent
   * a waiting notice is about (spec `ask-entitlement` §5.4). Absent when the
   * bridged-card path is not wired, in which case every waiting notice is
   * delivered — today's behaviour.
   */
  asks?: StandingAskCards;
}

/** The in-process serialization key for one platform chat. */
function serialKey(adapterId: string, chatId: string): string {
  return `${adapterId} ${chatId}`;
}

/**
 * Separator for the busy damper's key. Named, and a PRINTABLE character on
 * purpose: `notice-log.ts` records what an invisible NUL in this exact position
 * cost the last reader who met one, and a separator nobody can see in a diff is
 * a separator nobody can check.
 */
const BUSY_DAMP_KEY_SEPARATOR = '::';

/** The `(room, agent)` key of the busy damper. Nothing parses it back apart. */
function busyDampKey(roomId: string, agentAuthorId: string): string {
  return `${roomId}${BUSY_DAMP_KEY_SEPARATOR}${agentAuthorId}`;
}

/**
 * The agent an `agent_busy` notice is about, or `undefined` when this entry is
 * not one (or names nobody).
 *
 * @param entry - The entry to read.
 */
function busySubjectOf(entry: RoomEntry): string | undefined {
  if (entry.kind !== 'notice' || entry.body.notice !== 'agent_busy') return undefined;
  return entry.body.subjectAuthorId;
}

/** Whether a publish came back refused by the consent gate (spec §6.6). */
function wasConsentDenied(result: PublishResult): boolean {
  return (result.rejected ?? []).some((r) => r.reason === 'initiate_denied');
}

/** The provenance of an entry, plus the inbound ref it answers when it is a reply. */
interface Provenance {
  classification: BridgePrincipalClassification;
  /** The inbound ref of the message this entry answers, when it is a reply (spec §6.5). */
  answers: ExternalRef | null;
}

/**
 * The outbound bridge (chats-as-channels spec §6). One instance per server; it
 * holds the per-chat serialization chains and the notice damper.
 */
export class ChatBridgeDelivery {
  private readonly deps: ChatBridgeDeliveryDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryBackoffMs: readonly number[];
  /** Resolves the real operator-name prefix (spec §6.7); see {@link ChatBridgeDeliveryDeps.operatorDisplayName}. */
  private readonly operatorDisplayName: () => string | null;
  /** Per-`(adapterId, chatId)` serialization tail — deliveries never interleave (spec §10.2). */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Per-`(roomId, noticeCode)` last-written time, for the notice damper. */
  private readonly noticedAt = new Map<string, number>();
  /**
   * `(roomId, agentAuthorId)` pairs whose `agent_busy` line the CHAT has already
   * been sent, until that agent's next outcome in that room
   * ({@link ChatBridgeDelivery.rearmsBusy}).
   *
   * **The bridge needs its own memory here because the room's deliberately
   * stops damping in a DM (DOR-1359).** `RoomNoticeLog.reportSilence` damps on
   * `(room, agent, reason)` — except for a message that directly ASKED the
   * agent, and `directlyAsked` counts every human depth-0 message in a `dm` as
   * asking (`notice-log.ts`). That is the right conduct rule for the room: a
   * person who types "are you there?" is owed an answer every time. It is the
   * wrong rule for a platform chat, where each line is a push notification —
   * and a bridged private chat is exactly a `dm` with `deliverNotices` seeded
   * on, so three messages typed in one breath at an agent that is busy
   * elsewhere would buzz a phone three times. The room log still answers every
   * one of them; only the delivery is damped.
   *
   * Bounded by the number of live bridged rooms (a bridged room holds exactly
   * one agent, spec §3.4), so it needs no FIFO of its own.
   */
  private readonly busyToldChat = new Set<string>();
  /** The catch-up scan to re-run after a delivery recovers (spec §6.1's third trigger). */
  private onRecovered?: (roomId: string) => void;

  constructor(deps: ChatBridgeDeliveryDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.operatorDisplayName = deps.operatorDisplayName ?? (() => null);
  }

  /**
   * Wire the catch-up scan that runs after a delivery recovers from a transient
   * failure (spec §6.1's "after a delivery failure resolves" trigger). Set after
   * construction because delivery and the scan hold each other — the scan calls
   * {@link ChatBridgeDelivery.deliverEntry}, and a recovered delivery re-runs the
   * scan to flush whatever queued behind the failure.
   *
   * @param onRecovered - Re-scan this room; typically `catchUp.scanRoom`.
   */
  setRecoveryHook(onRecovered: (roomId: string) => void): void {
    this.onRecovered = onRecovered;
  }

  /**
   * The startup stranded-ref reconciliation (spec §10.1's crash divergence,
   * DOR-898). Run once, alongside {@link BridgeCatchUp.scanAll} (see
   * `binding-subsystem.ts`) — the same moment in the boot sequence, because a
   * process that starts back up is exactly when a PRIOR process's crash
   * becomes visible.
   *
   * Finds every outbound ref whose platform id is still null and old enough
   * ({@link STRANDED_OUTBOUND_REF_THRESHOLD_MS}) that it cannot still be a
   * legitimate in-flight write-before-send, and posts one damped
   * `bridge_undelivered` notice per stranded ref — the SAME notice
   * {@link ChatBridgeDelivery.attemptDelivery}'s exhausted-retry path already
   * writes, so a person reads one consistent message whether their entry was
   * refused by the retry ladder or orphaned by a crash.
   *
   * **Deliberately does not delete the ref or re-send the entry.** The
   * crashed process may have completed the platform call before it died —
   * write-before-send means the ref existing tells us nothing about whether
   * the send landed. Rolling the ref back would return the entry to the
   * catch-up scan's candidate set and re-deliver it, and if the crashed send
   * DID land, that is a duplicate: a message the person on the other end sees
   * twice, with no way to recall it. That is the one failure mode the whole
   * write-before-send design (spec §6.3) exists to avoid, so this sweep never
   * risks it. The notice is the whole fix — it turns a silent, permanent
   * stall into a visible one, and leaves the decision (resend, correct, or
   * let it go) to a human.
   */
  async sweepStrandedRefs(): Promise<void> {
    const cutoff = new Date(this.now() - STRANDED_OUTBOUND_REF_THRESHOLD_MS).toISOString();
    const stale = this.deps.bridges.listStaleNullOutboundRefs(cutoff);
    for (const ref of stale) {
      const entry = this.deps.entries.getEntryById(ref.roomId, ref.entryId);
      this.postUndeliveredNotice(ref.roomId, entry?.body.text ?? '(message unavailable)');
    }
  }

  /**
   * The inline fast path (spec §6.1): try to deliver an entry the instant it
   * commits. Fire-and-forget and swallowed — a committed entry is never lost to
   * a delivery failure, and the catch-up scan is the authority that will retry.
   * Bails in one indexed lookup for an unbridged room, which is the only cost an
   * ordinary (non-bridged) commit pays (spec §14).
   *
   * @param entry - The just-committed entry.
   */
  onCommit(entry: RoomEntry): void {
    const bridge = this.deps.bridges.findBridgeByRoom(entry.roomId);
    if (!bridge || bridge.archivedAt !== null) return;
    void this.deliverEntry(entry, bridge).catch((err) => {
      logger.warn('[chat-bridge] inline delivery threw', {
        roomId: entry.roomId,
        entryId: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Deliver one committed room entry to its platform chat, serialized behind
   * every other delivery for the same `(adapterId, chatId)` so two never
   * interleave and a 429's wait holds the entries queued behind it in `seq`
   * order (spec §10.2). Idempotent on the entry: an existing ref of either
   * direction is a no-op (spec §6.3).
   *
   * @param entry - The entry to deliver.
   * @param bridge - The room's bridge row, when the caller already resolved it.
   */
  deliverEntry(entry: RoomEntry, bridge?: Bridge): Promise<DeliverOutcome> {
    const live = bridge ?? this.deps.bridges.findBridgeByRoom(entry.roomId);
    if (!live || live.archivedAt !== null) return Promise.resolve<DeliverOutcome>('no_bridge');
    const key = serialKey(live.adapterId, live.chatId);
    const prior = this.chains.get(key) ?? Promise.resolve();
    const run = prior.then(() => this.deliverSerial(entry, live));
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(key, tail);
    void tail.finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  /** One entry's delivery, already serialized for its chat. */
  private async deliverSerial(entry: RoomEntry, bridge: Bridge): Promise<DeliverOutcome> {
    // Echo suppression AND idempotence, in one structural check (spec §6.3):
    // an inbound ref means the entry came FROM the chat (never send it back,
    // A6.1); an outbound ref means it is already delivered or being delivered
    // (a retry is a no-op, A6.2). Nothing heuristic — the ref table is the only
    // mechanism.
    const existing = this.deps.bridges.findRefByEntry(entry.id);
    if (existing) return existing.direction === 'inbound' ? 'echo' : 'noop';

    // Eligibility criterion 2 (spec §6.1): a post always; a notice only when
    // this bridge delivers notices and the code is one a person on the far end
    // needs (§6.2, DELIVERABLE_NOTICES). The scan hands the SAME test to a
    // notice committed while the adapter was down, which is the whole reason a
    // bridged DM delivers notices at all (spec §6.1).
    if (entry.kind === 'notice') {
      if (!bridge.deliverNotices) return 'skipped';
      if (!entry.body.notice || !DELIVERABLE_NOTICES.has(entry.body.notice)) return 'skipped';
      // A turn that already got a real Approve/Deny card does not also get the
      // sentence: the approver would see the card immediately and a
      // near-duplicate line a minute later (spec `ask-entitlement` §5.4). The
      // room's own entry is written either way — only its DELIVERY is
      // suppressed — so the cockpit's reading of the room is unchanged.
      if (
        entry.body.notice === 'awaiting_approval' &&
        this.deps.asks?.hasStandingCard(bridge.roomId, entry.body.subjectAuthorId)
      ) {
        return 'skipped';
      }
    } else if (entry.kind !== 'post') {
      return 'skipped';
    }

    // Eligibility criterion 4 (spec §6.1, §6.6 step 2, A6.5): a delivered POST
    // must be the bound agent's or the operator's. This is where "an agent
    // cannot deliver to a chat it is not bound to" rests — not on the consent
    // gate, which never sees an author. A bridged room holds exactly one agent
    // (§3.4) and posting requires membership, so an agent-kind author with a
    // post here IS the bound agent; anyone else is refused before any publish.
    // Notices are the room's own voice and carry no such author.
    const author = this.deps.authors.getById(entry.authorId);
    if (entry.kind === 'post') {
      const isOperator = entry.authorId === this.deps.operatorAuthorId();
      const isAgent = author?.kind === 'agent';
      if (!isOperator && !isAgent) return 'refused_author';
    }

    // The busy damper's two halves, in the order that keeps them honest: an
    // entry that proves this agent got somewhere re-arms the line BEFORE the
    // next one is weighed, so an agent that answers and then goes busy again
    // says so again (DOR-1359).
    this.rearmsBusy(entry, author);
    if (this.busyIsARepeat(entry, bridge)) return 'damped';

    const subject = this.deps.resolveSubject(bridge);
    if (!subject) {
      logger.warn('[chat-bridge] could not build an outbound subject; refusing delivery', {
        roomId: bridge.roomId,
        adapterId: bridge.adapterId,
      });
      return 'no_bridge';
    }

    // Criterion 5 is enforced by the consent gate, but its INPUT — the
    // reply-vs-initiate classification — is decided here, room-scoped, because
    // the gate is two strings and cannot see the cascade (spec §6.6).
    const provenance = this.classifyProvenance(entry, bridge);
    const from = buildBridgePrincipal(provenance.classification, bridge.adapterId, bridge.chatId);
    const content = this.buildContent(entry, author);
    const payload = this.buildPayload(content, provenance);

    // WRITE-BEFORE-SEND (spec §6.3): the outbound ref exists, with a null
    // platform id, before the platform is ever called.
    this.deps.bridges.recordOutboundRef({
      roomId: bridge.roomId,
      entryId: entry.id,
      chatId: bridge.chatId,
      adapterId: bridge.adapterId,
      threadId: provenance.answers?.threadId ?? null,
      createdAt: new Date(this.now()).toISOString(),
    });

    return this.attemptDelivery({ entry, bridge, subject, from, payload, author, provenance });
  }

  /**
   * The failure ladder (spec §10.1–§10.3): send, and on failure retry with
   * bounded backoff, honour a 429's `retry_after`, treat a 403 as terminal, and
   * on an exhausted budget roll the ref back and post `bridge_undelivered`.
   */
  private async attemptDelivery(ctx: {
    entry: RoomEntry;
    bridge: Bridge;
    subject: string;
    from: string;
    payload: Record<string, unknown>;
    author: AuthorRecord | null | undefined;
    provenance: Provenance;
  }): Promise<DeliverOutcome> {
    const { entry, bridge, subject, from, payload, author, provenance } = ctx;
    const attempts = this.retryBackoffMs.length + 1;

    for (let i = 0; i < attempts; i += 1) {
      // `from` is always a `relay.bridge.*` principal here (built by
      // `buildBridgePrincipal` above), so this trusted server publisher asserts
      // the DOR-889 trust marker; without it the pipeline guard would reject the
      // delivery as a caller-supplied bridge principal.
      const result = await this.deps.publisher.publish(subject, payload, {
        from,
        serverBridgePrincipal: true,
      });

      // Consent refusal (spec §6.6): the gate denied it. Keep the ref so it is
      // never retried into the same wall (re-enabling a switch does not
      // resurrect an old post — that would be a surprise send), roll nothing
      // back, and say so in the room, damped.
      if (wasConsentDenied(result)) {
        this.postBlockedNotice(bridge.roomId, this.blockedReason(provenance, entry, author));
        return 'blocked';
      }

      const ar = result.adapterResult;
      // Deliberate non-send by the adapter (its own echo, a stream event it does
      // not render). Not a delivery and not a failure; leave the ref and stop.
      if (ar?.skipped) return 'noop';
      if (ar?.success) {
        // Patch the platform id in (spec §6.3). Prefer the adapter's own message
        // id; fall back to the relay message id only so the ref is non-null
        // (delivered) even if an adapter did not surface one.
        this.deps.bridges.patchOutboundPlatformId(
          entry.id,
          ar.responseMessageId ?? result.messageId
        );
        this.deps.bridges.stampActivity(bridge.roomId, new Date(this.now()).toISOString());
        // The busy damper arms only on a line that actually LANDED. Arming it
        // before the send would let a blocked or exhausted delivery silence
        // every later busy line about a state the chat was never told about
        // (DOR-1359).
        this.armBusyDamp(entry, bridge);
        // Recovered from a transient failure: re-scan the room to flush whatever
        // queued behind it (spec §6.1's third trigger). Only after a real retry —
        // a first-attempt success has nothing stranded behind it.
        if (i > 0) this.onRecovered?.(bridge.roomId);
        return 'delivered';
      }

      // 403: the bot was blocked, kicked, or the chat is gone (spec §10.3).
      // Terminal — never retried. Roll the ref back and hand the archival to the
      // lifecycle, carrying the platform's own reason.
      if (ar?.code === 'chat_unavailable') {
        this.deps.bridges.deleteOutboundRef(entry.id);
        await this.deps.lifecycle.unbridge(bridge.bindingId, {
          ...(ar.error ? { reason: ar.error } : {}),
        });
        return 'terminal';
      }

      const isLast = i === attempts - 1;
      if (isLast) break;

      // 429 honours `retry_after` exactly (spec §10.2); anything else backs off
      // exponentially (spec §10.1). Either way the wait is held INSIDE the
      // per-chat chain, so later entries queue behind it in `seq` order.
      const waitMs =
        ar?.code === 'rate_limited' && ar.retryAfterMs !== undefined
          ? ar.retryAfterMs
          : this.retryBackoffMs[i];
      await this.sleep(waitMs);
    }

    // The budget is spent (spec §10.1). This send is KNOWN not to have landed —
    // running code observed every failed attempt — so roll the ref back, which
    // returns the entry to the catch-up scan's candidate set for the next
    // reconnect, and name it in a damped `bridge_undelivered` notice so the
    // suppressed case is never silent (spec §6.3).
    this.deps.bridges.deleteOutboundRef(entry.id);
    this.postUndeliveredNotice(bridge.roomId, entry.body.text);
    return 'undelivered';
  }

  /**
   * Classify an entry as a reply or an initiate, room-scoped (spec §6.6).
   *
   * An entry is a REPLY iff its `cascadeRoot` names an entry IN THIS ROOM that
   * carries an INBOUND ref for THIS bridge's `(adapterId, chatId)`. The
   * room-and-chat scoping is load-bearing: `deepestClaimOf` picks a claim across
   * every room, so an agent triggered in bridged chat R that also posts into
   * bridged chat S would inherit R's inbound root — and without this condition,
   * a stranger's mention in R would launder an initiate into S past
   * `canInitiate: false` (spec §6.6, the cross-room leak).
   */
  private classifyProvenance(entry: RoomEntry, bridge: Bridge): Provenance {
    // A self-rooted entry answers nothing.
    if (entry.cascadeRoot === entry.id) return { classification: 'initiate', answers: null };
    // A root not in THIS room reads as null — the cross-room case, an initiate.
    const root = this.deps.entries.getEntryById(bridge.roomId, entry.cascadeRoot);
    if (!root) return { classification: 'initiate', answers: null };
    const rootRef = this.deps.bridges.findRefByEntry(root.id);
    if (
      rootRef?.direction === 'inbound' &&
      rootRef.adapterId === bridge.adapterId &&
      rootRef.chatId === bridge.chatId
    ) {
      return { classification: 'reply', answers: rootRef };
    }
    return { classification: 'initiate', answers: null };
  }

  /**
   * The wire content for an entry (spec §6.7). A post whose author is NOT the
   * bound agent — in practice the operator posting from the cockpit — is
   * prefixed with a REAL operator name, at delivery time only. The prefix is
   * NEVER written into the entry body: the log holds exactly what the person
   * typed, and a stored prefix would re-apply on every re-delivery. Notices and
   * the bound agent's own posts carry no prefix — the bot IS the agent's
   * identity, so its own words need none.
   *
   * **The prefix is never the author row's `displayName` (DOR-899).** By the
   * time a `post`-kind entry reaches here, {@link ChatBridgeDelivery.deliverSerial}
   * has already refused every author but the bound agent or the operator
   * (spec §6.6 step 2), so a non-agent author is always the operator — and
   * the operator author's cached `displayName` is fixed at `'You'`
   * (`author-registry.ts`), a word that is correct only from the operator's
   * own cockpit seat. {@link ChatBridgeDeliveryDeps.operatorDisplayName}
   * resolves a real configured name instead, falling back to
   * {@link OPERATOR_FALLBACK_LABEL} — never `'You'` — when none is set.
   *
   * **A `turn_failed` notice is re-rendered, not forwarded (spec §6.2).** The
   * room's own copy of it points a reader at "Ana's session" — the right
   * pointer for a cockpit reader, meaningless to a person on Telegram who has
   * no session to open. {@link ChatBridgeDelivery.buildContent} sends this
   * one plain sentence instead; the stored entry, and what a cockpit reader
   * sees scrolling the same room, is unchanged. Every other deliverable
   * notice, and every post, forwards its stored text as-is.
   */
  private buildContent(entry: RoomEntry, author: AuthorRecord | null | undefined): string {
    if (entry.kind === 'notice') return this.buildNoticeContent(entry);
    const text = entry.body.text;
    if (author?.kind === 'agent') return text;
    const name = this.operatorDisplayName() ?? OPERATOR_FALLBACK_LABEL;
    return `${name}: ${text}`;
  }

  /**
   * The delivered text for a notice. Only {@link DELIVERABLE_NOTICES} ever
   * reach here (the eligibility gate in {@link ChatBridgeDelivery.deliverSerial}
   * refuses every other code before content is ever built), and only
   * `turn_failed` needs a different rendering than the room's own line — see
   * {@link ChatBridgeDelivery.buildContent}.
   *
   * **`awaiting_approval` forwards verbatim even though its line ends in "Open
   * Ana's session to answer" (DOR-1359).** That clause is the one cockpit
   * pointer that survives into a chat, and `turn_failed`'s treatment above is
   * the obvious remedy — but it is not available here at the same price. A
   * failed turn has one sentence; a wait has three, one per `WaitingKind`
   * (approve / a question / needs something), and the kind is not on the
   * entry. Re-rendering would mean either putting `WaitingKind` on
   * `RoomEntryBody` — a schema field with exactly one reader — or collapsing
   * the three into one vaguer sentence, which costs the reader the only fact
   * the line carries. Forwarding is the honest middle: the bridged DM a notice
   * is delivered to by default is usually the operator's own account (spec
   * §6.2), so the session it points at is generally theirs to open. Revisit it
   * with the actionable bridged Ask (DOR-1356), which decides what a chat
   * reader can do about a wait rather than only what they are told.
   */
  private buildNoticeContent(entry: RoomEntry): string {
    if (entry.body.notice === 'turn_failed') {
      return bridgeTurnFailedText(this.subjectName(entry));
    }
    if (entry.body.notice === 'awaiting_approval') {
      // `waitingKind` is absent on entries written before it existed, and
      // `bridgeWaitingText` reads that as an approval — the commonest kind and
      // the one whose sentence says least.
      return bridgeWaitingText(this.subjectName(entry), entry.body.waitingKind);
    }
    return entry.body.text;
  }

  /**
   * The display name of whoever a notice is ABOUT, for the far-end rendering.
   *
   * @param entry - The notice entry, carrying `subjectAuthorId`.
   */
  private subjectName(entry: RoomEntry): string {
    const subjectId = entry.body.subjectAuthorId;
    const subject = subjectId ? this.deps.authors.getById(subjectId) : null;
    return subject?.displayName ?? 'The agent';
  }

  /** The outbound payload: content, plus reply/topic targeting for a reply (spec §6.5). */
  private buildPayload(content: string, provenance: Provenance): Record<string, unknown> {
    const payload: Record<string, unknown> = { content };
    const answers = provenance.answers;
    if (answers) {
      if (answers.platformMessageId) payload.replyToMessageId = answers.platformMessageId;
      if (answers.threadId) payload.messageThreadId = answers.threadId;
    }
    return payload;
  }

  /**
   * Which `bridge_blocked` copy a refusal gets (spec §6.6). A blocked reply
   * names the reply switch; a blocked initiate from the operator names the
   * initiate switch; a blocked initiate from the AGENT is the post-restart
   * lost-provenance case — an answer whose cascade did not survive a restart,
   * which self-rooted and classified as an initiate — and gets the dedicated
   * restart copy.
   */
  private blockedReason(
    provenance: Provenance,
    entry: RoomEntry,
    author: AuthorRecord | null | undefined
  ): BridgeBlockedReason {
    if (provenance.classification === 'reply') return 'reply_off';
    if (entry.kind === 'post' && author?.kind === 'agent') return 'lost_provenance';
    return 'initiate_off';
  }

  /**
   * Whether this `agent_busy` notice repeats one the chat has already had.
   *
   * Only `agent_busy` is damped here, and the asymmetry with
   * `awaiting_approval` is not an oversight: `RoomNoticeLog.reportWaiting`
   * already writes at most one waiting line per `(room, agent)` for the life of
   * the turn, with no direct-question exception, so one wait is already one
   * room entry and the bridge has nothing left to merge. The busy line has that
   * exception and needs this.
   *
   * A notice with no `subjectAuthorId` names no agent, so there is nothing to
   * key on and it is never damped — it delivers, which is the safe side.
   *
   * @param entry - The entry being delivered.
   * @param bridge - Its room's bridge row.
   */
  private busyIsARepeat(entry: RoomEntry, bridge: Bridge): boolean {
    const agentAuthorId = busySubjectOf(entry);
    if (!agentAuthorId) return false;
    return this.busyToldChat.has(busyDampKey(bridge.roomId, agentAuthorId));
  }

  /**
   * Record that the chat has now been told this agent is busy.
   *
   * @param entry - The entry that was just delivered.
   * @param bridge - Its room's bridge row.
   */
  private armBusyDamp(entry: RoomEntry, bridge: Bridge): void {
    const agentAuthorId = busySubjectOf(entry);
    if (agentAuthorId) this.busyToldChat.add(busyDampKey(bridge.roomId, agentAuthorId));
  }

  /**
   * Clear the busy damp when an entry shows that agent's turn here reached an
   * OUTCOME — the same re-arm `RoomNoticeLog.recovered` uses, read off the log
   * instead of off a callback, because the bridge sees every committed entry in
   * a bridged room and needs no new signal.
   *
   * Exactly two entries qualify, and the narrowness is deliberate:
   *
   * - **an agent's own post** — it answered here, so the next time it cannot is
   *   news again; and
   * - **a `turn_failed` notice about it** — it tried here and broke, which is
   *   an outcome too.
   *
   * An `awaiting_approval` notice does NOT re-arm: it says the agent is working
   * in THIS room, which is not the state a busy line describes (busy means a
   * claim somewhere else), so treating it as recovery would re-open the line
   * without anything having changed about it.
   *
   * The consequence worth naming: an agent that stays busy elsewhere and never
   * speaks here leaves the chat with exactly one busy line until it does. That
   * is the intended trade — the room's own log still answers every message
   * (`notice-log.ts`'s direct-question rule), and the chat is the surface where
   * a repeat is a push notification.
   *
   * @param entry - The entry being delivered.
   * @param author - Its resolved author, already looked up by the caller.
   */
  private rearmsBusy(entry: RoomEntry, author: AuthorRecord | null | undefined): void {
    const agentAuthorId =
      entry.kind === 'post' && author?.kind === 'agent'
        ? entry.authorId
        : entry.kind === 'notice' && entry.body.notice === 'turn_failed'
          ? entry.body.subjectAuthorId
          : undefined;
    if (agentAuthorId) this.busyToldChat.delete(busyDampKey(entry.roomId, agentAuthorId));
  }

  /** Write one `bridge_blocked` notice, damped per `(room, reason)` (spec §6.6). */
  private postBlockedNotice(roomId: string, reason: BridgeBlockedReason): void {
    // Damp on the notice CODE, not the reason variant: all three variants share
    // the `bridge_blocked` code, and a person does not need three near-identical
    // lines when several posts are blocked at once.
    this.postDamped(roomId, 'bridge_blocked', () => buildBridgeBlockedNotice(reason));
  }

  /** Write one `bridge_undelivered` notice naming the entry, damped per room (spec §10.1). */
  private postUndeliveredNotice(roomId: string, text: string): void {
    this.postDamped(roomId, 'bridge_undelivered', () => buildBridgeUndeliveredNotice(text));
  }

  /**
   * Write a room notice at most once per {@link NOTICE_DAMP_MS} per
   * `(room, code)`, best-effort — a notice that cannot land (the room was
   * archived out of band) must never turn a delivery outcome into a throw.
   */
  private postDamped(roomId: string, code: string, build: () => RoomEntryBody): void {
    const at = this.now();
    const stampKey = `${roomId}:${code}`;
    const last = this.noticedAt.get(stampKey);
    if (last !== undefined && at - last < NOTICE_DAMP_MS) return;
    this.noticedAt.set(stampKey, at);
    try {
      this.deps.rooms.postNotice(roomId, build());
    } catch (err) {
      // Forget the stamp so the next occurrence gets a chance to speak once the
      // room is live again.
      this.noticedAt.delete(stampKey);
      logger.warn('[chat-bridge] could not write a bridge notice', {
        roomId,
        code,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
