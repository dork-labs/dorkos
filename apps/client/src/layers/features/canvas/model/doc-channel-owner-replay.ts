/** Genuine HTTP/page/pending custody and ONE persistent owner-lifetime cursor. */
import {
  CanvasChannelReplayResponseSchema,
  type CanvasChannelReplayResponse,
  type CanvasChannelFrame,
} from '@dorkos/shared/canvas-channel-schemas';
import type { CanvasDocIncarnation } from '@dorkos/shared/canvas-doc-frame-wire';
import { DocChannelCursor } from './doc-channel-cursor-state';
import {
  requireOwnedCustody,
  readOwnedFacts,
  readOwnedTransport,
  reserveOwnedRun,
  ownedRunCurrent,
  admitOwnedReplay,
  deliverOwnedFrame,
  completeOwnedCatchup,
  failOwnedReplay,
  unavailableOwnedReplay,
  readOwnedNoticeForReplay,
  deliverOwnedNoticeFrame,
} from './doc-channel-owner-custody';
import { readOwnAdmissionForReplay, readOwnedAdvanceForReplay } from './doc-channel-owner-record';

interface RunEntry {
  owner: object;
  subject?: object;
  epoch: number;
  revision: number;
  observation: number;
  ended: boolean;
  starting: number;
  succeeded: boolean;
  target?: number;
  targetBirth?: CanvasDocIncarnation;
  lastPage?: object;
}
interface PageEntry {
  owner: object;
  run: object;
  response: CanvasChannelReplayResponse;
  since: number;
  revision: number;
  observation: number;
  phase: 'read' | 'consuming' | 'frames' | 'finished';
  admissionRead: boolean;
  frames: readonly CanvasChannelFrame[];
  next: number;
  dispatching?: number;
  advanced: boolean;
}
interface PendingEntry {
  owner: object;
  run: object;
  frame: CanvasChannelFrame;
  phase: 'taken' | 'dispatching' | 'finished';
  advanced: boolean;
}
const cursors = new WeakMap<object, DocChannelCursor>();
const runs = new WeakMap<object, RunEntry>();
const pages = new WeakMap<object, PageEntry>();
const pending = new WeakMap<object, PendingEntry>();
function cursor(owner: object): DocChannelCursor {
  requireOwnedCustody(owner);
  const value = cursors.get(owner);
  if (!value) throw new Error('Replay owner lifetime is absent.');
  return value;
}
function ownRun(owner: object, run: object): RunEntry {
  const value = runs.get(run);
  if (!value || value.owner !== owner) throw new Error('Replay run is foreign.');
  return value;
}
/** JSON schema output is detached; retain immutable facts rather than a caller mutation surface. */
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}
/** Install one persistent cursor and replay lifetime for this genuine custody owner. */
export function createOwnedReplayLifetime(owner: object): void {
  requireOwnedCustody(owner);
  if (cursors.has(owner)) throw new Error('Replay owner lifetime is already initialized.');
  cursors.set(owner, new DocChannelCursor());
}
/** Inert cursor projection only: no raw mutable cursor or callback permission is exposed. */
export function readOwnedCursor(owner: object) {
  const value = cursor(owner);
  return Object.freeze({
    highest: value.highest,
    through: value.catchUpThrough,
    pending: value.pendingCount,
  });
}
/** Reduction only, called by fixed core invalidation before observable cleanup. */
export function resetOwnedCursor(owner: object): void {
  cursor(owner).reset();
}
/** Read only a run captured by this owner’s real replay lifecycle. */
export function readOwnedRunCapture(owner: object, run: object) {
  const value = runs.get(run);
  if (!value || value.owner !== owner) return undefined;
  return Object.freeze({
    subject: value.subject,
    epoch: value.epoch,
    revision: value.revision,
    observation: value.observation,
    ended: value.ended,
  });
}
/** Select the captured owned HTTP page, retaining original run and birth boundaries. */
export function readOwnedPageForAdmission(owner: object, run: object, page: object) {
  const value = pages.get(page),
    entry = runs.get(run);
  if (
    !entry ||
    entry.owner !== owner ||
    !value ||
    value.owner !== owner ||
    value.run !== run ||
    value.phase !== 'consuming' ||
    value.admissionRead ||
    !ownedRunCurrent(owner, run)
  )
    return undefined;
  value.admissionRead = true;
  return Object.freeze({
    response: value.response,
    since: value.since,
    revision: value.revision,
    observation: value.observation,
    targetBirth: entry.targetBirth,
  });
}
/** Own unissued→issued handoff is inert and callback-free BEFORE any projection notification. */
export function acceptOwnAdmission(owner: object, run: object, page: object): void {
  const entry = ownRun(owner, run),
    value = pages.get(page);
  const admission = readOwnAdmissionForReplay(owner, run, page);
  if (
    !admission ||
    !value ||
    value.owner !== owner ||
    value.run !== run ||
    value.phase !== 'consuming' ||
    !value.admissionRead ||
    entry.ended ||
    entry.epoch !== admission.epoch ||
    entry.subject !== admission.previous
  )
    throw new Error('Replay own issuance is foreign or stale.');
  entry.subject = admission.subject;
}
/** Read one captured HTTP or pending frame for the exact owned run phase. */
export function readOwnedFrameForCore(
  owner: object,
  run: object,
  ticket: object,
  fromPending: boolean
): CanvasChannelFrame | undefined {
  if (!ownedRunCurrent(owner, run)) return undefined;
  if (fromPending) {
    const value = pending.get(ticket);
    return value &&
      value.owner === owner &&
      value.run === run &&
      value.phase === 'dispatching' &&
      !value.advanced
      ? value.frame
      : undefined;
  }
  const value = pages.get(ticket);
  return value &&
    value.owner === owner &&
    value.run === run &&
    value.phase === 'frames' &&
    value.dispatching !== undefined &&
    !value.advanced
    ? value.frames[value.dispatching]
    : undefined;
}
/** Only a core-created one-shot advance witness permits this genuine frame's cursor effect. */
export function advanceOwnedFrameCursor(
  owner: object,
  run: object,
  ticket: object,
  fromPending: boolean
): void {
  const frame = readOwnedAdvanceForReplay(owner, run, ticket, fromPending);
  if (!frame || !ownedRunCurrent(owner, run))
    throw new Error('Replay cursor advance has no genuine core witness.');
  const value = fromPending ? pending.get(ticket) : pages.get(ticket);
  if (!value || value.advanced) throw new Error('Replay frame advance was consumed.');
  value.advanced = true;
  cursor(owner).advance(frame.docSeq);
}
/** Read the current run’s retained catch-up completion witness. */
export function readOwnedCatchupForAdmission(owner: object, run: object) {
  const entry = runs.get(run),
    page = entry?.lastPage && pages.get(entry.lastPage);
  if (
    !entry ||
    entry.owner !== owner ||
    !ownedRunCurrent(owner, run) ||
    entry.target === undefined ||
    !page ||
    page.phase !== 'finished' ||
    page.next !== page.frames.length ||
    (page.response.events.length >= 200 && cursor(owner).highest < entry.target)
  )
    return undefined;
  const value = cursor(owner);
  return Object.freeze({
    highest: value.highest,
    through: value.catchUpThrough,
    target: entry.target,
  });
}
/** Genuine notice key is inserted only by the core's actual captured Transport subscription. */
export function consumeOwnedNotice(owner: object, key: object): boolean {
  const notice = readOwnedNoticeForReplay(owner, key);
  if (!notice) throw new Error('Replay notice is foreign or stale.');
  const value = cursor(owner),
    frame = notice.notification;
  if (notice.mode === 'quarantine') {
    value.markThrough(
      frame.type === 'canvas_channel_snapshot' ? frame.snapshot.highWatermark : frame.docSeq
    );
    if (frame.type !== 'canvas_channel_snapshot') value.recordGap(frame);
  } else if (notice.mode === 'gap' && frame.type !== 'canvas_channel_snapshot') {
    return value.recordGap(frame);
  } else if (notice.mode === 'event') {
    deliverOwnedNoticeFrame(owner, key);
  }
  return false;
}
/** Advance the persistent cursor only from this owner’s genuine subscription notice. */
export function advanceOwnedNoticeCursor(owner: object, key: object): void {
  const notice = readOwnedNoticeForReplay(owner, key);
  if (!notice || notice.mode !== 'event' || notice.notification.type === 'canvas_channel_snapshot')
    throw new Error('Notice cursor advance is foreign.');
  cursor(owner).advance(notice.notification.docSeq);
}

/** Reserve genuine originating membership BEFORE the core installs the active run. */
export function createOwnedReplayRun(owner: object) {
  const facts = readOwnedFacts(owner),
    value = cursor(owner),
    identity = Object.freeze({});
  const entry: RunEntry = {
    owner,
    subject: facts.subject,
    epoch: facts.epoch,
    revision: facts.revision,
    observation: facts.observation,
    ended: false,
    starting: value.highest,
    succeeded: false,
  };
  runs.set(identity, entry);
  reserveOwnedRun(owner, identity);
  const current = () => ownedRunCurrent(owner, identity);
  const interruption = (): 'restart' | 'stop' | undefined =>
    !readOwnedFacts(owner).live ? 'stop' : !current() ? 'restart' : undefined;
  return Object.freeze({
    async readPage(): Promise<object | null> {
      if (!current()) return null;
      const captured = readOwnedFacts(owner),
        since = value.highest;
      const transport = readOwnedTransport(owner),
        read = transport.getCanvasChannel;
      if (!current()) return null;
      const raw = await read.call(transport, facts.documentId, { since, limit: 200 });
      if (!current()) return null;
      const response = freezeData(CanvasChannelReplayResponseSchema.parse(raw));
      if (!current()) return null;
      const ticket = Object.freeze({});
      pages.set(ticket, {
        owner,
        run: identity,
        response,
        since,
        revision: captured.revision,
        observation: captured.observation,
        phase: 'read',
        admissionRead: false,
        frames: [],
        next: 0,
        advanced: false,
      });
      return ticket;
    },
    consumePage(ticket: object) {
      const page = pages.get(ticket);
      if (
        !current() ||
        !page ||
        page.owner !== owner ||
        page.run !== identity ||
        page.phase !== 'read'
      )
        return { kind: 'done' as const };
      page.phase = 'consuming';
      const outcome = admitOwnedReplay(owner, identity, ticket);
      if (outcome !== 'accepted' || !current()) {
        page.phase = 'finished';
        return { kind: 'done' as const };
      }
      entry.target ??= page.response.highWatermark;
      entry.targetBirth = page.response.incarnation;
      page.frames = Object.freeze(
        page.response.events.filter((frame) => frame.docSeq <= entry.target!)
      );
      page.phase = 'frames';
      entry.lastPage = ticket;
      if (page.response.resetRequired) value.advance(page.response.retentionFloor - 1);
      return { kind: 'frames' as const, count: page.frames.length };
    },
    advancePageFrame(ticket: object, index: number): boolean {
      const page = pages.get(ticket);
      if (
        !current() ||
        !page ||
        page.owner !== owner ||
        page.run !== identity ||
        page.phase !== 'frames' ||
        index !== page.next ||
        !page.frames[index]
      )
        return false;
      page.next = index + 1;
      page.dispatching = index;
      page.advanced = false;
      try {
        return deliverOwnedFrame(owner, identity, ticket, false) && current();
      } finally {
        page.dispatching = undefined;
      }
    },
    finishPage(ticket: object): 'again' | 'done' {
      const page = pages.get(ticket);
      if (
        !current() ||
        !page ||
        page.owner !== owner ||
        page.run !== identity ||
        page.phase !== 'frames' ||
        page.next !== page.frames.length ||
        entry.target === undefined
      )
        return 'done';
      page.phase = 'finished';
      if (page.response.events.length < 200 || value.highest >= entry.target) {
        value.advance(entry.target);
        if (!current()) return 'done';
        completeOwnedCatchup(owner, identity);
        if (!current()) return 'done';
        entry.succeeded = true;
        return 'done';
      }
      if (value.highest <= page.since) throw new Error('Document replay made no progress.');
      return 'again';
    },
    failed() {
      if (current()) failOwnedReplay(owner, identity);
    },
    beginFinalization() {
      return interruption() ?? (entry.succeeded ? 'drain' : 'stop');
    },
    takePending(): object | null {
      if (!current()) return null;
      const frame = value.takeNextContiguous();
      if (!frame || !current()) return null;
      const ticket = Object.freeze({});
      pending.set(ticket, { owner, run: identity, frame, phase: 'taken', advanced: false });
      return ticket;
    },
    advancePending(ticket: object): boolean {
      const captured = pending.get(ticket);
      if (
        !current() ||
        !captured ||
        captured.owner !== owner ||
        captured.run !== identity ||
        captured.phase !== 'taken'
      )
        return false;
      captured.phase = 'dispatching';
      try {
        return deliverOwnedFrame(owner, identity, ticket, true) && current();
      } finally {
        captured.phase = 'finished';
        pending.delete(ticket);
      }
    },
    finishFinalization() {
      const before = interruption();
      if (before) return before;
      if (value.clearReachedTarget()) {
        const changed = interruption();
        if (changed) return changed;
        completeOwnedCatchup(owner, identity);
        const qualified = interruption();
        if (qualified) return qualified;
      }
      if (value.pendingCount || value.catchUpThrough > value.highest) {
        const now = readOwnedFacts(owner);
        if (
          value.highest > entry.starting ||
          now.revision > entry.revision ||
          now.observation > entry.observation
        )
          return 'restart';
        unavailableOwnedReplay(owner, identity);
      }
      return interruption() ?? 'stop';
    },
    current,
    end: () => {
      entry.ended = true;
    },
  });
}
