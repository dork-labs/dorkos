/** Original protected native Relay fact/CAS sibling. No SDK authority or callback registrar. */
import { randomUUID, createHash } from 'node:crypto';
import {
  consumeRelayNativeConstruction,
  requireRelayNativeDatabase,
  type openProtectedRoomNativeDatabase,
} from './room-spend-native.js';
import type { RelayDocNativeOperation } from './relay-doc-statements.js';
import {
  copySelector,
  checkedRows,
  checkedInput,
  orderedJson,
  iso,
  type Rows,
  readOriginalRelaySource,
  type Native,
  type RelayNativeSelector,
  type OriginalRelayNativeFacts,
  type OriginalRelayNativeClaim,
} from './relay-doc-native-data.js';
export type {
  RelayNativeSelector,
  OriginalRelayNativeFacts,
  OriginalRelayNativeClaim,
} from './relay-doc-native-data.js';
import type {
  RelayFactsState,
  RelayClaimState,
  RelayNativeOperationContext,
} from './relay-doc-native-operation-context.js';
import { claimOriginalRelay } from './relay-doc-native-claim.js';
import { settleOriginalRelay } from './relay-doc-native-settlement.js';

const facts = new WeakMap<OriginalRelayNativeFacts, RelayFactsState>();
const claims = new WeakMap<OriginalRelayNativeClaim, RelayClaimState>();
const operationOwners = new WeakMap<object, RelayNativeOperationContext>();
const ownerGet = WeakMap.prototype.get;
const ownerSet = WeakMap.prototype.set;
const ownerApply = Reflect.apply;
/** Internal lookup accepts only an inaccessible constructor-owned key. No issuer is exported. */
export function requireRelayNativeOperationOwner(key: object): RelayNativeOperationContext {
  const context = ownerApply(ownerGet, operationOwners, [key]) as
    RelayNativeOperationContext | undefined;
  if (!context) throw new Error('Original native Relay operation owner required');
  return context;
}
/** Constructed only by the original Db factory before public exposure. Fixed native calls are captured. */
export class OriginalRelayDocStorage {
  readonly #operationKey = {};
  readonly #bootEpoch = randomUUID();
  readonly #begin: Native['beginRelayFrame'];
  readonly #run: Native['executeRelayFrame'];
  readonly #commit: Native['commitRelayFrame'];
  readonly #rollback: Native['rollbackRelayFrame'];
  readonly #committed: Native['committedRelayFrame'];
  constructor(native: Native) {
    consumeRelayNativeConstruction(native);
    this.#begin = native.beginRelayFrame;
    this.#run = native.executeRelayFrame;
    this.#commit = native.commitRelayFrame;
    this.#rollback = native.rollbackRelayFrame;
    this.#committed = native.committedRelayFrame;
    ownerApply(ownerSet, operationOwners, [
      this.#operationKey,
      {
        owner: this,
        bootEpoch: this.#bootEpoch,
        begin: () => this.#begin(),
        run: (...args: Parameters<Native['executeRelayFrame']>) => this.#run(...args),
        commit: (frame: object) => this.#commit(frame),
        rollback: (frame: object) => this.#rollback(frame),
        committed: (frame: object) => this.#committed(frame),
        read: (frame: object, selector: RelayNativeSelector, now: string) =>
          this.#read(frame, selector, now),
        facts,
        claims,
      } satisfies RelayNativeOperationContext,
    ]);
  }
  #read(frame: object, selector: RelayNativeSelector, now: string) {
    return readOriginalRelaySource((...args) => this.#run(...args), frame, selector, now);
  }
  capture(selectorData: RelayNativeSelector, now: string): OriginalRelayNativeFacts {
    const selector = copySelector(selectorData);
    iso(now);
    let frame: object | undefined;
    let failed = false;
    let first: unknown;
    let result: OriginalRelayNativeFacts | undefined;
    try {
      frame = this.#begin();
      const read = this.#read(frame, selector, now);
      if (!this.#rollback(frame)) throw new Error('Native Relay capture rollback UNKNOWN');
      frame = undefined;
      result = Object.freeze({ kind: 'original-relay-native-facts' });
      facts.set(result, {
        owner: this,
        selector,
        ...read,
        consumed: false,
        claimState: 'unattempted',
      });
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (frame) {
      const closed = this.#rollback(frame);
      if (!closed && !failed) {
        failed = true;
        first = new Error('Native Relay capture closure UNKNOWN');
      }
    }
    if (failed) throw first;
    return result!;
  }
  /** Atomically consume original accepted receipt and charge its approved route before any SDK FIRST. */
  claim(
    token: OriginalRelayNativeFacts,
    now: string,
    turnsPerHour: number,
    bindingId: string,
    turnStartSeq: number
  ): OriginalRelayNativeClaim {
    return claimOriginalRelay(
      this.#operationKey,
      token,
      now,
      turnsPerHour,
      bindingId,
      turnStartSeq
    );
  }
  /** Fixed terminal ledger CAS, called only after original server closed-turn correlation. */
  settle(
    token: OriginalRelayNativeClaim,
    now: string,
    outcome: 'completed' | 'failed' | 'blocked'
  ) {
    return settleOriginalRelay(this.#operationKey, token, now, outcome);
  }
  /** Fresh original claimed state read; it does not report SDK FIRST or certify process start. */
  requireClaimCurrent(token: OriginalRelayNativeClaim, now: string): void {
    const own = claims.get(token);
    if (!own || own.owner !== this) throw new Error('Original native Relay claim required');
    const at = iso(now);
    let frame: object | undefined;
    let failed = false;
    let first: unknown;
    try {
      frame = this.#begin();
      const claimed = checkedRows(this.#run(frame, 'started', own.bindings), 2);
      if (claimed.length !== 1) throw new Error('Original claimed Relay receipt changed');
      const ledger = {
        batch: checkedRows(this.#run(frame, 'fullBatch', own.selector), 2),
        receipt: checkedRows(this.#run(frame, 'fullReceipt', own.selector), 2),
        deliveries: checkedRows(this.#run(frame, 'fullDeliveries', own.selector), 101),
      };
      if (
        JSON.stringify(ledger) !== JSON.stringify(own.ledgerSnapshot) ||
        checkedRows(this.#run(frame, 'queueRow', own.bindings), 2).length !== 0
      )
        throw new Error('Original claimed Relay full ledger/queue changed');
      const rows = (
        operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
        max: number
      ) => checkedRows(this.#run(frame!, operation, own.selector), max);
      const channel = rows('channel', 2),
        grant = rows('grant', 2),
        document = rows('document', 2),
        target = rows('target', 2),
        inputs = rows('inputs', 101);
      if (
        channel.length !== 1 ||
        grant.length !== 1 ||
        document.length !== 1 ||
        target.length !== 1 ||
        inputs.length < 1 ||
        inputs.length > 100
      )
        throw new Error('Original claimed Relay source absent');
      const hash = createHash('sha256')
        .update(JSON.stringify({ channel, grant, document, target, inputs }))
        .digest('hex');
      if (hash !== own.sourceHash) throw new Error('Original claimed Relay source changed');
      const expiry = grant[0]!.expires_at;
      if (expiry !== null && (typeof expiry !== 'string' || iso(expiry) <= at))
        throw new Error('Original claimed Relay grant expired');
      const principal = checkedRows(
        this.#run(frame, 'principal', { ...own.selector, bindingId: own.bindingId, now }),
        2
      );
      if (principal.length !== 1 || JSON.stringify(principal) !== JSON.stringify(own.principal))
        throw new Error('Original claimed Relay principal changed');
      if (!this.#rollback(frame))
        throw new Error('Original claimed Relay current read closure UNKNOWN');
      frame = undefined;
    } catch (cause) {
      failed = true;
      first = cause;
    }
    if (frame) {
      const closed = this.#rollback(frame);
      if (!closed && !failed) {
        failed = true;
        first = new Error('Original claimed Relay closure UNKNOWN');
      }
    }
    if (failed) throw first;
  }
}

export interface ServerNativeRelayConstruction {
  readonly kind: 'server-native-relay-construction';
}
export interface FixedNativeRelayFacts {
  capture(selector: RelayNativeSelector, now: string): OriginalRelayNativeFacts;
  claim(
    facts: OriginalRelayNativeFacts,
    now: string,
    turnsPerHour: number,
    bindingId: string,
    turnStartSeq: number
  ): OriginalRelayNativeClaim;
  readCommittedStartHint(claim: OriginalRelayNativeClaim): Readonly<{
    documentId: string;
    eventId: string;
    docSeq: number;
    envelopeHash: string;
    direction: 'system';
    type: 'event.status';
    receivedAt: string;
  }>;
  settle(
    claim: OriginalRelayNativeClaim,
    now: string,
    outcome: 'completed' | 'failed' | 'blocked'
  ): ReturnType<OriginalRelayDocStorage['settle']>;
  requireClosed(): void;
  requireKnownNoClaim(facts: OriginalRelayNativeFacts): void;
  requireClaimCurrent(claim: OriginalRelayNativeClaim, now: string): void;
}
const originalConstructions = new WeakMap<
  ServerNativeRelayConstruction,
  { native: Native; db?: object; consumed: boolean; facade: FixedNativeRelayFacts }
>();
/** Original factory only. Exact SAME native Db must be wrapped before single consuming assembly. */
export function constructOriginalRelayDocStorage(native: Native) {
  const storage = new OriginalRelayDocStorage(native);
  const requireClosed = native.requireRelayFramesClosed;
  const capture = storage.capture.bind(storage),
    claim = storage.claim.bind(storage),
    requireClaimCurrent = storage.requireClaimCurrent.bind(storage);
  const settle = storage.settle.bind(storage);
  const facade = Object.freeze({
    capture,
    claim,
    requireClaimCurrent,
    requireClosed,
    settle,
    readCommittedStartHint(token: OriginalRelayNativeClaim) {
      const own = claims.get(token);
      if (!own || own.owner !== storage) throw new Error('Original committed Relay hint required');
      return own.startHint;
    },
    requireKnownNoClaim(token: OriginalRelayNativeFacts) {
      const own = facts.get(token);
      if (
        !own ||
        own.owner !== storage ||
        (own.claimState !== 'unattempted' && own.claimState !== 'rollback_closed')
      )
        throw new Error('Original native Relay no-claim closure UNKNOWN');
    },
  });
  const token: ServerNativeRelayConstruction = Object.freeze({
    kind: 'server-native-relay-construction',
  });
  const own = { native, db: undefined as object | undefined, consumed: false, facade };
  originalConstructions.set(token, own);
  return Object.freeze({
    serverNativeRelayConstruction: token,
    bindOriginalWrappedDb(db: object) {
      if (own.db) throw new Error('Original Relay database already bound');
      requireRelayNativeDatabase(native, db);
      own.db = db;
    },
  });
}
/** Consume the once-only Relay construction bound to this exact database handle. */
export function consumeServerNativeRelayConstruction(
  token: ServerNativeRelayConstruction,
  db: object
): FixedNativeRelayFacts {
  const own = originalConstructions.get(token);
  if (!own || own.consumed || own.db !== db)
    throw new Error('Original Relay construction unavailable');
  requireRelayNativeDatabase(own.native, db);
  own.consumed = true;
  return own.facade;
}
