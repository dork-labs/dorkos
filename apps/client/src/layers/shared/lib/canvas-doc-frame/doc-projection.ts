/** Birth-local projections and publisher capabilities; stream data cannot install a replacement. */
import {
  CanvasDocIncarnationSchema,
  parseCanvasDocWire,
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from '@dorkos/shared/canvas-doc-frame-wire';
import {
  CanvasChannelReplayResponseSchema,
  inspectCanvasChannelJson,
  CanvasChannelFrameSchema,
  type CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';
/** Actual producer slots have independently retiring epochs under one captured transport owner. */
export type DocPublisherSlot = 'session-generator' | 'session-manager' | 'room';
/** Host-only capability issued by the registry; payloads cannot mint an owner or epoch. */
export interface DocPublisherToken {
  readonly slot: DocPublisherSlot;
  readonly epoch: number;
  readonly owner: object;
}
/** Registry covers all producer slots without activating any actual stream caller. */
export class DocPublisherRegistry {
  private readonly active = new Map<DocPublisherSlot, DocPublisherToken>();
  private epoch = 0;
  constructor(
    private readonly owner: object,
    private readonly ownerCurrent: (owner: object) => boolean
  ) {
    if (!owner || typeof owner !== 'object' || typeof ownerCurrent !== 'function')
      throw new Error('Captured transport owner required.');
  }
  /** Replace a slot synchronously; callbacks holding its old capability immediately fail. */
  capture(slot: DocPublisherSlot): DocPublisherToken {
    if (!['session-generator', 'session-manager', 'room'].includes(slot))
      throw new Error('Known publisher slot required.');
    if (this.epoch === Number.MAX_SAFE_INTEGER) throw new Error('Publisher epoch exhausted.');
    const token = Object.freeze({ slot, epoch: ++this.epoch, owner: this.owner });
    this.active.set(slot, token);
    return token;
  }
  /** Discard a stale publisher, including same-payload callbacks after reconnect. */
  retire(token: DocPublisherToken): void {
    if (this.active.get(token.slot) === token) this.active.delete(token.slot);
  }
  /** Deliver only under an actual active captured capability; never inspect payload owner claims. */
  publish(token: DocPublisherToken, receive: () => void): boolean {
    if (this.active.get(token.slot) !== token || !currentOwner(this.ownerCurrent, this.owner))
      return false;
    if (this.active.get(token.slot) !== token) return false;
    receive();
    return true;
  }
}
/** Replay request identity issued locally; a delayed response cannot install another incarnation. */
export interface DocReplayToken {
  readonly epoch: number;
}
/** Reducer keys monotonic state by full birth, retaining no old cursors across replacement. */
export class DocBirthProjection {
  private epoch = 0;
  private request: DocReplayToken | null = null;
  private birth: CanvasDocIncarnation | null = null;
  private replay: CanvasChannelReplayResponse | null = null;
  private unavailable = true;
  private exhausted = false;
  private readonly retiredBirths = new Set<string>();
  constructor(
    private readonly owner: object,
    private readonly ownerCurrent: (owner: object) => boolean,
    private scope: string
  ) {
    if (!scope || scope.length > 200) throw new Error('Actual owning scope required.');
    if (!owner || typeof owner !== 'object' || typeof ownerCurrent !== 'function')
      throw new Error('Captured transport owner required.');
  }
  /** Capture the only replay request currently allowed to establish a birth. */
  requestReplay(): DocReplayToken {
    this.request = Object.freeze({ epoch: ++this.epoch });
    return this.request;
  }
  /** Authoritative replay installs a birth; legacy absence disables Doc while leaving the content mount alone. */
  installReplay(token: DocReplayToken, value: unknown, response: unknown): boolean {
    if (this.exhausted || this.request !== token || !currentOwner(this.ownerCurrent, this.owner))
      return false;
    if (this.exhausted || this.request !== token || this.epoch !== token.epoch) return false;
    const birth = parseCanvasDocWire(CanvasDocIncarnationSchema, value),
      replay = parseReplay(response);
    if (
      !birth ||
      !replay ||
      replay.events.some(
        (frame) => frame.documentId !== birth.documentId || frame.scope !== this.scope
      ) ||
      this.retiredBirths.has(JSON.stringify(birth))
    ) {
      this.unavailable = true;
      return false;
    }
    if (this.birth && !sameCanvasDocIncarnation(this.birth, birth)) {
      if (this.retiredBirths.size >= 100) {
        this.exhausted = true;
        this.retire();
        return false;
      }
      this.retiredBirths.add(JSON.stringify(this.birth));
    }
    this.birth = Object.freeze(birth);
    this.replay = freezeProjection(replay);
    this.unavailable = false;
    this.request = null;
    return true;
  }
  /** Live events never establish a birth; sequence comparisons only occur inside the installed birth. */
  applyLive(value: unknown, frame: unknown): boolean {
    const birth = parseCanvasDocWire(CanvasDocIncarnationSchema, value),
      parsed = parseCanvasDocWire(CanvasChannelFrameSchema, frame);
    if (
      !currentOwner(this.ownerCurrent, this.owner) ||
      !this.birth ||
      !birth ||
      !sameCanvasDocIncarnation(this.birth, birth)
    ) {
      this.unavailable = true;
      return false;
    }
    if (
      this.unavailable ||
      !parsed ||
      parsed.documentId !== this.birth.documentId ||
      parsed.scope !== this.scope ||
      !this.replay ||
      parsed.docSeq <= this.replay.highWatermark
    )
      return false;
    // State mutation payloads are not a second authority: repair from the current replay.
    if (parsed.event.type.startsWith('state.')) {
      this.unavailable = true;
      return false;
    }
    if (parsed.docSeq !== this.replay.highWatermark + 1) {
      this.unavailable = true;
      return false;
    }
    this.replay = freezeProjection({
      ...this.replay,
      highWatermark: parsed.docSeq,
      events: [...this.replay.events, parsed].slice(-200),
    });
    return true;
  }
  /** Host canonical rekey invalidates repairs without inventing a replacement birth. */
  rebindScope(scope: string): void {
    if (!scope || scope.length > 200) throw new Error('Actual owning scope required.');
    if (scope !== this.scope) {
      this.scope = scope;
      this.epoch++;
      this.request = null;
      this.unavailable = true;
    }
  }
  /** Current read-only projection data; no draft/content/focus fields are owned or reset here. */
  getCurrent(): Readonly<{
    birth: CanvasDocIncarnation | null;
    replay: CanvasChannelReplayResponse | null;
    available: boolean;
  }> {
    const authorized = currentOwner(this.ownerCurrent, this.owner);
    return Object.freeze({
      birth: this.birth,
      replay: this.replay,
      available: authorized && !this.unavailable,
    });
  }
  /** Transport replacement retires request/cursor/state/receipts without inheriting old work. */
  retire(): void {
    this.epoch++;
    this.request = null;
    this.birth = null;
    this.replay = null;
    this.unavailable = true;
  }
}

function freezeProjection<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}

function currentOwner(check: (owner: object) => boolean, owner: object): boolean {
  try {
    return check(owner) === true;
  } catch {
    return false;
  }
}

// A replay contains up to 200 separately bounded events/receipts plus live state.
// It is not a queued SDK envelope; bound the complete projection independently.
function parseReplay(value: unknown): CanvasChannelReplayResponse | null {
  try {
    if (inspectCanvasChannelJson(value, 16 * 1024 * 1024) !== undefined) return null;
    const parsed = CanvasChannelReplayResponseSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
