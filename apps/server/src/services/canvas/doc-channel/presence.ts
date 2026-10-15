/** Ephemeral per-mount ledger. Only its owning native engine publishes transitions. */
import { randomUUID } from 'node:crypto';
import type { CanvasChannelPresenceRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { z } from 'zod';
export type PresenceRequest = z.infer<typeof CanvasChannelPresenceRequestSchema>;
interface Mount {
  readonly id: string;
  readonly caller: string;
  readonly mountId: string | undefined;
  readonly at: number;
  readonly focused: boolean;
  readonly focusAt: number | null;
}
interface DocumentMounts {
  readonly mounts: ReadonlyMap<string, Mount>;
}
export interface PresencePlan {
  readonly documentId: string;
  readonly viewerId: string;
  readonly views: number;
  readonly opened: boolean;
  readonly closed: number;
  readonly countChanged: boolean;
  readonly focused?: boolean;
}
const TTL = 75_000;
/** One process-owned ledger; a new constructor has no viewers from a prior boot. */
export class OriginalDocPresenceLedger {
  readonly #documents = new Map<string, DocumentMounts>();
  readonly #plans = new WeakMap<
    PresencePlan,
    { before: DocumentMounts | undefined; after: DocumentMounts }
  >();
  #closed = false;
  /** Prepare DATA only; native transaction failure never changes live membership. */
  prepare(documentId: string, caller: string, request: PresenceRequest, now: number): PresencePlan {
    if (this.#closed || !Number.isFinite(now)) throw new Error('Original presence owner retired');
    const before = this.#documents.get(documentId);
    const mounts = new Map(before?.mounts);
    const live = request.action === 'mount' ? undefined : mounts.get(request.viewerId);
    if (request.action !== 'mount' && (!live || live.caller !== caller || now - live.at >= TTL))
      throw Object.assign(new Error('The document viewer is unavailable.'), { status: 404 });
    let removed = 0;
    for (const [id, value] of mounts)
      if (request.action !== 'focus' && now - value.at >= TTL) {
        mounts.delete(id);
        removed++;
      }
    // A logical mount key identifies only this caller's retry; native viewer identity stays server-issued.
    const retry =
      request.action === 'mount' && request.mountId !== undefined
        ? [...mounts.values()].find(
            (value) => value.caller === caller && value.mountId === request.mountId
          )
        : undefined;
    if (retry) return this.#plan(documentId, before, mounts, retry.id, false, removed);
    const viewerId = request.action === 'mount' ? randomUUID() : request.viewerId;
    if (request.action === 'unmount') {
      mounts.delete(viewerId);
      removed++;
    } else if (request.action === 'focus') {
      if (!live) throw new Error('Original focus mount missing');
      // Focus never extends the heartbeat TTL. A burst cannot turn this log into a clock.
      const accepted =
        live.focused !== request.focused && (live.focusAt === null || now - live.focusAt >= 500);
      mounts.set(
        viewerId,
        accepted ? Object.freeze({ ...live, focused: request.focused, focusAt: now }) : live
      );
      return this.#plan(
        documentId,
        before,
        mounts,
        viewerId,
        false,
        removed,
        accepted ? request.focused : undefined
      );
    } else
      mounts.set(
        viewerId,
        Object.freeze({
          id: viewerId,
          caller,
          mountId: request.action === 'mount' ? request.mountId : live?.mountId,
          at: now,
          focused: live?.focused ?? false,
          focusAt: live?.focusAt ?? null,
        })
      );
    return this.#plan(documentId, before, mounts, viewerId, request.action === 'mount', removed);
  }
  /** Expire actual recorded mounts once; no fabricated request or caller is required. */
  expire(
    documentId: string,
    now: number,
    retiredCallers: ReadonlySet<string> = new Set()
  ): PresencePlan | undefined {
    if (this.#closed || !Number.isFinite(now)) throw new Error('Original presence owner retired');
    const before = this.#documents.get(documentId);
    if (!before) return;
    const mounts = new Map(before.mounts);
    for (const [id, value] of mounts)
      if (retiredCallers.has(value.caller) || now - value.at >= TTL) mounts.delete(id);
    const removed = before.mounts.size - mounts.size;
    if (!removed) return;
    return this.#plan(documentId, before, mounts, '', false, removed);
  }
  #plan(
    documentId: string,
    before: DocumentMounts | undefined,
    mounts: Map<string, Mount>,
    viewerId: string,
    opened: boolean,
    removed: number,
    focused?: boolean
  ): PresencePlan {
    const plan = Object.freeze({
      documentId,
      viewerId,
      views: mounts.size,
      opened,
      closed: removed,
      countChanged: mounts.size !== (before?.mounts.size ?? 0),
      ...(focused === undefined ? {} : { focused }),
    });
    this.#plans.set(plan, { before, after: { mounts } });
    return plan;
  }
  /** Lookup only: actual focus stage must still own the same live caller-bound mount. */
  requireFocus(plan: PresencePlan, caller: string, now: number): void {
    const own = this.#plans.get(plan);
    const live = own?.before?.mounts.get(plan.viewerId);
    if (
      this.#closed ||
      !own ||
      this.#documents.get(plan.documentId) !== own.before ||
      plan.focused === undefined ||
      !live ||
      live.caller !== caller ||
      now - live.at >= TTL
    )
      throw new Error('Original document focus mount retired');
  }
  /** The constructor-owned quiet expiry publisher recognizes only a private removal plan. */
  requireExpiry(plan: PresencePlan): void {
    const own = this.#plans.get(plan);
    if (
      this.#closed ||
      !own ||
      this.#documents.get(plan.documentId) !== own.before ||
      plan.opened ||
      plan.viewerId !== '' ||
      plan.focused !== undefined ||
      plan.closed < 1
    )
      throw new Error('Original presence expiry plan differs');
  }
  /** Commit only this exact retained plan after the owning native transition succeeds. */
  commit(plan: PresencePlan): void {
    const own = this.#plans.get(plan);
    if (this.#closed || !own || this.#documents.get(plan.documentId) !== own.before)
      throw new Error('Original presence plan changed');
    this.#plans.delete(plan);
    if (own.after.mounts.size) this.#documents.set(plan.documentId, own.after);
    else this.#documents.delete(plan.documentId);
  }
  /** Retire only a positively closed native source or caller; no error-code inference. */
  retire(documentId: string, caller?: string): void {
    if (this.#closed) throw new Error('Original presence owner retired');
    const before = this.#documents.get(documentId);
    if (!before) return;
    if (caller === undefined) {
      this.#documents.delete(documentId);
      return;
    }
    const mounts = new Map(before.mounts);
    for (const [id, mount] of mounts) if (mount.caller === caller) mounts.delete(id);
    if (mounts.size) this.#documents.set(documentId, { mounts });
    else this.#documents.delete(documentId);
  }
  /** Positive private ledger membership, used only with the owning committed context. */
  hasDocument(documentId: string): boolean {
    return this.#documents.has(documentId);
  }
  /** Private lookup; does not reveal a mount or issue authority. */
  hasCaller(documentId: string, caller: string): boolean {
    for (const mount of this.#documents.get(documentId)?.mounts.values() ?? [])
      if (mount.caller === caller) return true;
    return false;
  }
  /** Earliest live deadline, used by the owning captured engine timer. */
  next(
    skip: ReadonlySet<string> = new Set()
  ): Readonly<{ documentId: string; at: number }> | undefined {
    let next: { documentId: string; at: number } | undefined;
    for (const [documentId, value] of this.#documents)
      if (!skip.has(documentId))
        for (const mount of value.mounts.values())
          if (!next || mount.at + TTL < next.at) next = { documentId, at: mount.at + TTL };
    return next && Object.freeze(next);
  }
  /** Synchronous retirement precedes any owning async timer-work join. */
  stop(): void {
    this.#closed = true;
    this.#documents.clear();
  }
}

// Capture the module's actual original methods before its public class is exposed.
// The engine never resolves an authority method through that public prototype again.
const presenceApply = Reflect.apply;
const originalPresenceMethods = Object.freeze({
  prepare: OriginalDocPresenceLedger.prototype.prepare,
  expire: OriginalDocPresenceLedger.prototype.expire,
  requireFocus: OriginalDocPresenceLedger.prototype.requireFocus,
  requireExpiry: OriginalDocPresenceLedger.prototype.requireExpiry,
  commit: OriginalDocPresenceLedger.prototype.commit,
  retire: OriginalDocPresenceLedger.prototype.retire,
  hasDocument: OriginalDocPresenceLedger.prototype.hasDocument,
  hasCaller: OriginalDocPresenceLedger.prototype.hasCaller,
  next: OriginalDocPresenceLedger.prototype.next,
  stop: OriginalDocPresenceLedger.prototype.stop,
});

/** Construct an original private ledger with captured methods; no caller issues its plans. */
export function createOriginalDocPresenceLedger() {
  const owner = new OriginalDocPresenceLedger();
  return Object.freeze({
    prepare: (
      ...args: Parameters<typeof originalPresenceMethods.prepare>
    ): ReturnType<typeof originalPresenceMethods.prepare> =>
      presenceApply(originalPresenceMethods.prepare, owner, args),
    expire: (
      ...args: Parameters<typeof originalPresenceMethods.expire>
    ): ReturnType<typeof originalPresenceMethods.expire> =>
      presenceApply(originalPresenceMethods.expire, owner, args),
    requireFocus: (...args: Parameters<typeof originalPresenceMethods.requireFocus>): void =>
      presenceApply(originalPresenceMethods.requireFocus, owner, args),
    requireExpiry: (plan: PresencePlan): void =>
      presenceApply(originalPresenceMethods.requireExpiry, owner, [plan]),
    commit: (plan: PresencePlan): void =>
      presenceApply(originalPresenceMethods.commit, owner, [plan]),
    retire: (...args: Parameters<typeof originalPresenceMethods.retire>): void =>
      presenceApply(originalPresenceMethods.retire, owner, args),
    hasDocument: (documentId: string): boolean =>
      presenceApply(originalPresenceMethods.hasDocument, owner, [documentId]),
    hasCaller: (documentId: string, caller: string): boolean =>
      presenceApply(originalPresenceMethods.hasCaller, owner, [documentId, caller]),
    next: (
      ...args: Parameters<typeof originalPresenceMethods.next>
    ): ReturnType<typeof originalPresenceMethods.next> =>
      presenceApply(originalPresenceMethods.next, owner, args),
    stop: (): void => presenceApply(originalPresenceMethods.stop, owner, []),
  });
}
