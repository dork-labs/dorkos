import { types as nodeTypes } from 'node:util';
import type { BrowserRecord } from '../lifecycle/records.js';
import type { ProcessIdentity } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';

const brand = Symbol('engine generation return');
export interface DarwinGenerationReturn {
  readonly [brand]: true;
}
export interface DarwinGenerationBinding {
  readonly browserId: string;
  readonly browserGeneration: number;
  readonly reservationNonce: string;
  readonly manager: ProcessIdentity;
  readonly runtimeIdentityDigest: string;
}
/** Reject executable bindings before reading fields; even a getter can reenter token consumption. */
function dataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return null;
  if (Reflect.ownKeys(value).length !== fields.length) return null;
  const result = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor)) return null;
    result[field] = descriptor.value;
  }
  return result;
}
/** Private composition port; bind from the actual acquired reservation before cleanup clears it. */
export function createDarwinGenerationReturnOwner(
  records: Map<string, BrowserRecord>,
  record: BrowserRecord,
  runtimeIdentityDigest: string
) {
  const lifetime = record.lifetime,
    cell = lifetime.ordinary,
    slot = cell.retirement;
  const nonce = record.reservation?.nonce;
  if (
    !nonce ||
    !/^[a-f0-9]{64}$/.test(runtimeIdentityDigest) ||
    cell.records !== records ||
    cell.record !== record ||
    records.get(record.browserId) !== record
  )
    throw new Error('GENERATION_RETURN_UNAVAILABLE');
  const binding: DarwinGenerationBinding = Object.freeze({
    browserId: record.browserId,
    browserGeneration: record.browserGeneration,
    reservationNonce: nonce,
    manager: Object.freeze({ ...record.manager }),
    runtimeIdentityDigest,
  });
  const current = () =>
    records.get(binding.browserId) === record &&
    record.lifetime === lifetime &&
    record.browserGeneration === binding.browserGeneration &&
    sameProcess(record.manager, binding.manager) &&
    cell.record === record &&
    cell.records === records;
  const settled = () =>
    cell.phase === 'terminal' &&
    record.status === 'stopped' &&
    slot.result?.cleanup.state === 'settled' &&
    slot.result.terminal.cleanup === 'observed' &&
    slot.result.uncertainty.length === 0 &&
    lifetime.pending.size === 0 &&
    !lifetime.uncertain &&
    !lifetime.closeFailed &&
    !lifetime.releasePending;
  let issued: DarwinGenerationReturn | null = null,
    used = false;
  const completion = slot.promise.then((result) => {
    if (
      !current() ||
      slot.result !== result ||
      cell.phase !== 'terminal' ||
      record.status !== 'stopped' ||
      result.cleanup.state !== 'settled' ||
      result.terminal.cleanup !== 'observed' ||
      result.uncertainty.length ||
      lifetime.pending.size ||
      lifetime.uncertain ||
      lifetime.closeFailed ||
      lifetime.releasePending
    )
      return null;
    issued = Object.freeze({ [brand]: true as const });
    return issued;
  });
  return Object.freeze({
    binding,
    completion,
    consume(token: unknown, expected: DarwinGenerationBinding): boolean {
      const data = dataRecord(expected, [
        'browserId',
        'browserGeneration',
        'reservationNonce',
        'manager',
        'runtimeIdentityDigest',
      ]);
      const manager = data && dataRecord(data.manager, ['pid', 'birth']);
      if (!data || !manager) return false;
      if (
        !issued ||
        token !== issued ||
        used ||
        !current() ||
        !settled() ||
        data.browserId !== binding.browserId ||
        data.browserGeneration !== binding.browserGeneration ||
        data.reservationNonce !== binding.reservationNonce ||
        data.runtimeIdentityDigest !== binding.runtimeIdentityDigest ||
        manager.pid !== binding.manager.pid ||
        manager.birth !== binding.manager.birth
      )
        return false;
      used = true;
      return true;
    },
  });
}
