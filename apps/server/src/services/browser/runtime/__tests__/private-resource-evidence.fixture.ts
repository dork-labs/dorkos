import { z } from 'zod';
import {
  BrowserBindingSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserRenderReceiptSchema,
  BrowserViewerSchema,
} from '@dorkos/shared/browser-schemas';
import type { PrivateViewerSample } from '../private-native-acceptance.js';

/** Retain an original job and capture its rejection at settlement, before later body errors. */
export function retainOriginalResourceJob<T>(
  original: Promise<T>,
  capture: (value: unknown) => void
): Promise<T> {
  void original.catch(capture);
  return original;
}

const subject = z
  .object({
    open: BrowserProductionOpenReceiptSchema,
    drawn: BrowserRenderReceiptSchema,
    decoded: z.number().int().positive(),
    draws: z.number().int().positive(),
    bytes: z.number().int().positive(),
  })
  .strict();
/** Correlate genuine worker observations; this projection grants no browser authority. */
export function parseOriginalResourceReady(value: unknown) {
  const ready = z
    .object({ subjects: z.tuple([subject, subject]) })
    .strict()
    .parse(value);
  const [saved, clean] = ready.subjects;
  if (
    saved.open.instance.mode !== 'persistent' ||
    clean.open.instance.mode !== 'ephemeral' ||
    saved.open.binding.browserId === clean.open.binding.browserId ||
    saved.drawn.viewerId === clean.drawn.viewerId
  )
    throw new Error('RESOURCE_TWO_DISTINCT_ORIGINAL_BROWSERS_AND_VIEWERS_REQUIRED');
  for (const row of ready.subjects) {
    if (
      row.open.binding.browserId !== row.drawn.binding.browserId ||
      row.open.binding.browserGeneration !== row.drawn.binding.browserGeneration ||
      row.open.binding.tabId !== row.drawn.binding.tabId
    )
      throw new Error('RESOURCE_ORIGINAL_DRAW_SCOPE_MISMATCH');
  }
  return ready;
}
export type OriginalResourceReady = ReturnType<typeof parseOriginalResourceReady>;
const counts = z
  .object({
    viewerId: z.string(),
    binding: BrowserBindingSchema,
    leases: z
      .array(
        z
          .object({ viewer: BrowserViewerSchema, observedAt: z.number().int().positive().safe() })
          .strict()
      )
      .min(1)
      .max(128),
    decoded: z.number().int().nonnegative(),
    draws: z.number().int().nonnegative(),
    receipts: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
const snapshot = z
  .object({ at: z.number().int().positive(), viewers: z.tuple([counts, counts]) })
  .strict();
export function parseOriginalResourceStart(value: unknown) {
  const row = z
    .object({ subjects: z.tuple([subject, subject]), idleBefore: snapshot })
    .strict()
    .parse(value);
  return {
    ready: parseOriginalResourceReady({ subjects: row.subjects }),
    idleBefore: row.idleBefore,
  };
}
export function parseOriginalResourceCompletion(value: unknown) {
  return z
    .object({
      frames: z.number().int().positive(),
      bytes: z.number().int().positive(),
      idleBefore: snapshot,
      idleAfter: snapshot,
      activeBefore: snapshot,
      activeAfter: snapshot,
      report: z.unknown(),
    })
    .strict()
    .parse(value);
}
/** Zero idle deltas are data. Missing observers, replaced viewers and regressed counters refuse. */
export function originalResourceViewerInterval(
  ready: OriginalResourceReady,
  beforeValue: unknown,
  afterValue: unknown,
  samples: readonly PrivateViewerSample[],
  active: boolean
) {
  const before = snapshot.parse(beforeValue),
    after = snapshot.parse(afterValue);
  if (after.at <= before.at) throw new Error('RESOURCE_POSITIVE_OBSERVATION_WINDOW_REQUIRED');
  const rows = ready.subjects.map((subject, index) => {
    const a = before.viewers[index]!,
      b = after.viewers[index]!;
    const sameScope = (binding: typeof a.binding) =>
      Object.keys(subject.drawn.binding).every(
        (k) =>
          binding[k as keyof typeof binding] === subject.drawn.binding[k as keyof typeof binding]
      );
    const leases = new Map<string, (typeof b.leases)[number]>();
    for (const row of [a, b]) {
      if (!sameScope(row.binding)) throw new Error('RESOURCE_ORIGINAL_VIEWER_CHANGED');
      for (const lease of row.leases) {
        const prior = leases.get(lease.viewer.viewerId);
        if (
          !sameScope(lease.viewer.binding) ||
          !Number.isFinite(Date.parse(lease.viewer.expiresAt)) ||
          Date.parse(lease.viewer.expiresAt) <= lease.observedAt ||
          lease.observedAt > after.at ||
          (prior && JSON.stringify(prior) !== JSON.stringify(lease))
        )
          throw new Error('RESOURCE_ORIGINAL_LEASE_SUBSTITUTED');
        leases.set(lease.viewer.viewerId, lease);
      }
      if (!row.leases.some((lease) => lease.viewer.viewerId === row.viewerId))
        throw new Error('RESOURCE_ORIGINAL_LEASE_UNKNOWN');
    }
    if (
      !leases.has(subject.drawn.viewerId) ||
      a.leases.some(
        (lease) => !b.leases.some((next) => JSON.stringify(next) === JSON.stringify(lease))
      )
    )
      throw new Error('RESOURCE_ORIGINAL_LEASE_LINEAGE_LOST');
    // Exact current original bank issues expiresAt=Date.now()+30_000. Keep outer response
    // observation time separate: original bank samples can precede its HTTP delivery.
    const ordered = [...leases.values()].sort(
      (left, right) => Date.parse(left.viewer.expiresAt) - Date.parse(right.viewer.expiresAt)
    );
    if (
      ordered.some(
        (lease, n) =>
          n > 0 &&
          Date.parse(lease.viewer.expiresAt) - 30_000 > Date.parse(ordered[n - 1]!.viewer.expiresAt)
      )
    )
      throw new Error('RESOURCE_ORIGINAL_LEASE_GAP');
    if (
      Date.parse(ordered[0]!.viewer.expiresAt) - 30_000 > before.at ||
      Date.parse(ordered.at(-1)!.viewer.expiresAt) <= after.at
    )
      throw new Error('RESOURCE_ORIGINAL_LEASE_WINDOW_UNCOVERED');
    const delta = {
      decoded: b.decoded - a.decoded,
      draws: b.draws - a.draws,
      receipts: b.receipts - a.receipts,
      bytes: b.bytes - a.bytes,
    };
    if (
      Object.values(delta).some((n) => n < 0) ||
      (active && Object.values(delta).some((n) => n < 1))
    )
      throw new Error('RESOURCE_ORIGINAL_FRAME_COUNTERS_UNAVAILABLE');
    const observed = samples.filter(
      (sample) =>
        (leases.has(sample.viewerId) || sameScope(sample.binding)) &&
        sample.at >= before.at &&
        sample.at <= after.at
    );
    if (
      !observed.length ||
      observed.length > 2048 ||
      observed.some((sample) => {
        const lease = leases.get(sample.viewerId);
        return (
          !lease ||
          !sameScope(sample.binding) ||
          sample.at < Date.parse(lease.viewer.expiresAt) - 30_000 ||
          sample.at > Date.parse(lease.viewer.expiresAt) ||
          !Number.isSafeInteger(sample.pendingFrames) ||
          sample.pendingFrames < 0 ||
          sample.pendingFrames > 1 ||
          !Number.isSafeInteger(sample.pendingBytes) ||
          sample.pendingBytes < 0 ||
          sample.pendingBytes > 2 * 1024 * 1024 ||
          !Number.isSafeInteger(sample.droppedFrames) ||
          sample.droppedFrames < 0 ||
          (sample.encodingMs === null &&
            sample.at > Date.parse(lease.viewer.expiresAt) - 30_000 + 1500) ||
          (sample.encodingMs !== null &&
            (!Number.isFinite(sample.encodingMs) || sample.encodingMs < 0))
        );
      })
    )
      throw new Error('RESOURCE_ORIGINAL_QUEUE_OBSERVER_UNAVAILABLE');
    const available = observed.filter((sample) => !sample.closed && sample.encodingMs !== null);
    if (
      !available.length ||
      available[0]!.at > before.at + 1500 ||
      available.at(-1)!.at < after.at - 1500 ||
      available.some(
        (sample, n) =>
          n > 0 && (sample.at < available[n - 1]!.at || sample.at - available[n - 1]!.at > 1500)
      )
    )
      throw new Error('RESOURCE_ORIGINAL_QUEUE_OBSERVER_UNAVAILABLE');
    const perLease = ordered.map(({ viewer, observedAt }) => {
      const rows = observed.filter((sample) => sample.viewerId === viewer.viewerId);
      if (!rows.length)
        return { viewer, observedAt, samples: rows, droppedFramesDelta: 0, observed: false };
      if (!rows.some((sample) => sample.encodingMs !== null))
        throw new Error('RESOURCE_ORIGINAL_QUEUE_OBSERVER_UNAVAILABLE');
      if (
        rows.some(
          (sample, n) =>
            n > 0 &&
            (sample.at < rows[n - 1]!.at || sample.droppedFrames < rows[n - 1]!.droppedFrames)
        )
      )
        throw new Error('RESOURCE_ORIGINAL_DROP_COUNTER_REGRESSED');
      return {
        viewer,
        observedAt,
        samples: rows,
        droppedFramesDelta: rows.at(-1)!.droppedFrames - rows[0]!.droppedFrames,
        observed: true,
      };
    });
    return {
      viewerId: a.viewerId,
      binding: a.binding,
      leases: ordered,
      before: a,
      after: b,
      delta,
      queue: {
        samples: observed,
        maximumPendingFrames: Math.max(...observed.map((s) => s.pendingFrames)),
        maximumPendingBytes: Math.max(...observed.map((s) => s.pendingBytes)),
        encodingMilliseconds: available.map((s) => s.encodingMs),
        perLease,
        droppedFramesDelta: perLease.reduce((total, lease) => total + lease.droppedFramesDelta, 0),
      },
      nonzero: Object.fromEntries(Object.entries(delta).map(([k, n]) => [k, n > 0])),
    };
  });
  return {
    beforeAt: before.at,
    afterAt: after.at,
    elapsedMilliseconds: after.at - before.at,
    active,
    viewers: rows,
    bytes: rows.reduce((sum, r) => sum + r.delta.bytes, 0),
    frames: rows.reduce((sum, r) => sum + r.delta.draws, 0),
  };
}
