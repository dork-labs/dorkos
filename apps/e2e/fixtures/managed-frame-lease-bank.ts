import {
  BrowserViewerSchema,
  BrowserRenderReceiptSchema,
  BrowserBindingSchema,
  BrowserReferenceSchema,
  type BrowserBinding,
  type BrowserViewer,
} from '@dorkos/shared/browser-schemas';
export type OriginalFrameRole = 'primary' | 'secondary';
const same = (left: BrowserBinding, right: BrowserBinding) =>
  (Object.keys(left) as (keyof BrowserBinding)[]).every((key) => left[key] === right[key]);
/** Only actual public issuance observations from the two original Pages enter this ledger.
 * Renewal retains page/role and canonical binding; these references confer no authority. */
export class OriginalFrameLeaseBank {
  private readonly leases = new Map<string, { role: OriginalFrameRole; viewer: BrowserViewer }>();
  record(role: OriginalFrameRole, value: unknown): BrowserViewer {
    const viewer = BrowserViewerSchema.parse(value);
    const prior = this.leases.get(viewer.viewerId);
    if (
      prior &&
      (prior.role !== role ||
        !same(prior.viewer.binding, viewer.binding) ||
        prior.viewer.expiresAt !== viewer.expiresAt)
    )
      throw new Error('FRAME_ORIGINAL_LEASE_SUBSTITUTED');
    if (!prior && this.leases.size >= 128) throw new Error('FRAME_ORIGINAL_LEASE_BOUND');
    this.leases.set(viewer.viewerId, { role, viewer });
    return viewer;
  }
  originals(): ReadonlyArray<Readonly<{ role: OriginalFrameRole; viewer: BrowserViewer }>> {
    return [...this.leases.values()].map(({ role, viewer }) => ({
      role,
      viewer: { ...viewer, binding: { ...viewer.binding } },
    }));
  }
  role(viewerId: string, binding: BrowserBinding): OriginalFrameRole {
    const row = this.leases.get(viewerId);
    if (!row || !same(row.viewer.binding, binding))
      throw new Error('FRAME_ORIGINAL_LEASE_SCOPE_UNKNOWN');
    return row.role;
  }
  assertStallLease(viewerId: string, binding: BrowserBinding, now: number): BrowserViewer {
    if (this.role(viewerId, binding) !== 'secondary')
      throw new Error('FRAME_ORIGINAL_STALL_ROLE_UNKNOWN');
    const viewer = this.leases.get(viewerId)!.viewer;
    // Genuine production leases expire at30s and locally renew at29s. Never extend either clock.
    if (Date.parse(viewer.expiresAt) - now <= 11_000)
      throw new Error('FRAME_ORIGINAL_STALL_LEASE_TOO_SHORT');
    return viewer;
  }
}

export type OriginalFrameQueueSample = Readonly<{
  at: number;
  binding: BrowserBinding;
  viewerId: string;
  pendingFrames: number;
  pendingBytes: number;
  encodingMs: number | null;
  droppedFrames: number;
  closed: boolean;
}>;
/** Exact private publisher rows, including honest pre-first-capture null encoding.
 * Shared public schema parsers authenticate identifiers/bindings; private counters stay bounded. */
export function parseOriginalFrameQueue(value: unknown): OriginalFrameQueueSample[] {
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('FRAME_ORIGINAL_QUEUE_SHAPE');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(record, key))
    )
      throw new Error('FRAME_ORIGINAL_QUEUE_SHAPE');
    return record;
  };
  const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
      throw new Error('FRAME_ORIGINAL_QUEUE_COUNTER');
    return value;
  };
  const root = object(value, ['samples']);
  if (!Array.isArray(root.samples) || root.samples.length > 8192)
    throw new Error('FRAME_ORIGINAL_QUEUE_BOUND');
  return root.samples.map((value) => {
    const row = object(value, [
      'at',
      'binding',
      'viewerId',
      'pendingFrames',
      'pendingBytes',
      'encodingMs',
      'droppedFrames',
      'closed',
    ]);
    const encoding = row.encodingMs;
    if (
      encoding !== null &&
      (typeof encoding !== 'number' || !Number.isFinite(encoding) || encoding < 0)
    )
      throw new Error('FRAME_ORIGINAL_QUEUE_ENCODING');
    if (typeof row.closed !== 'boolean') throw new Error('FRAME_ORIGINAL_QUEUE_SHAPE');
    return {
      at: integer(row.at),
      binding: BrowserBindingSchema.parse(row.binding),
      viewerId: BrowserReferenceSchema.parse(row.viewerId),
      pendingFrames: integer(row.pendingFrames, 1),
      pendingBytes: integer(row.pendingBytes, 2 * 1024 * 1024),
      encodingMs: encoding,
      droppedFrames: integer(row.droppedFrames),
      closed: row.closed,
    };
  });
}

/** A renewed pump's first request legitimately has no prior draw. Invalid present receipts refuse. */
export function originalFramePriorDraw(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('FRAME_ORIGINAL_NEXT_SHAPE');
  if (!Object.hasOwn(value, 'receipt')) return null;
  return BrowserRenderReceiptSchema.parse((value as Record<string, unknown>).receipt);
}
/** Failure cancellation enters before joining actual response-body observations. */
export async function joinOriginalFrameLeaseSetup(options: {
  first: Readonly<{ value: unknown }> | undefined;
  originals: readonly Promise<unknown>[];
  closePrimary(): Promise<unknown>;
  unrouteSecondary(): Promise<unknown>;
  closeSecondary(): Promise<unknown>;
}) {
  let first = options.first;
  const closePrimary = options.closePrimary.bind(options);
  const unrouteSecondary = options.unrouteSecondary.bind(options);
  const closeSecondary = options.closeSecondary.bind(options);
  const originals = [...options.originals];
  let primary: Promise<unknown> | undefined;
  const stopPrimary = () => (primary ??= Promise.resolve().then(closePrimary));
  const observe = async (jobs: readonly Promise<unknown>[]) => {
    for (const original of jobs)
      void original.catch((value) => {
        first ??= { value };
      });
    for (const result of await Promise.allSettled(jobs))
      if (result.status === 'rejected') first ??= { value: result.reason };
  };
  for (const original of originals)
    void original.catch((value) => {
      first ??= { value };
      void stopPrimary().catch((later) => {
        first ??= { value: later };
      });
    });
  await observe([...(first ? [stopPrimary()] : []), Promise.resolve().then(unrouteSecondary)]);
  await observe([Promise.resolve().then(closeSecondary)]);
  if (first) await observe([stopPrimary()]);
  await observe(originals);
  if (primary) await observe([primary]);
  if (first) throw first.value;
}
