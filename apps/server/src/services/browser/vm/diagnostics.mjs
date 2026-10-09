import { Buffer } from 'node:buffer';
import { createDiagnosticsBudget } from '@dorkos/browser/server-owner';
import { performance } from 'node:perf_hooks';
const enums = {
  severity: ['debug', 'info', 'warning', 'error', 'unknown'],
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'other', 'unknown'],
  resource: ['document', 'script', 'style', 'image', 'font', 'fetch', 'media', 'other', 'unknown'],
  status: ['informational', 'success', 'redirect', 'clientError', 'serverError', 'unknown'],
  duration: ['under100ms', 'under1s', 'under10s', 'atLeast10s', 'unknown'],
};
const fields = {
  console: ['severity'],
  error: ['severity'],
  network: ['method', 'resource', 'status', 'duration'],
  lifecycle: [],
};
export function validateOriginalGuestDiagnostic(value) {
  if (value?.event === 'diagnostic-loss') {
    if (
      typeof value.tabId !== 'string' ||
      !/^[A-Za-z0-9_-]{22,64}$/.test(value.tabId) ||
      Object.keys(value).sort().join(',') !== 'correlationDropped,dropped,event,tabId' ||
      !Number.isSafeInteger(value.dropped) ||
      value.dropped < 0 ||
      !Number.isSafeInteger(value.correlationDropped) ||
      value.correlationDropped < 0
    )
      throw new Error('VM_DIAGNOSTIC_SCHEMA');
    return value;
  }
  const selected = fields[value?.category];
  if (
    !selected ||
    value.event !== 'diagnostic-observed' ||
    typeof value.tabId !== 'string' ||
    !/^[A-Za-z0-9_-]{22,64}$/.test(value.tabId) ||
    Object.keys(value).sort().join(',') !==
      ['event', 'tabId', 'category', ...selected].sort().join(',')
  )
    throw new Error('VM_DIAGNOSTIC_SCHEMA');
  for (const key of selected)
    if (!enums[key].includes(value[key])) throw new Error('VM_DIAGNOSTIC_SCHEMA');
  return value;
}
/** Shared actual engine budget, fixed scalar observations, host-minted counters.
 * No CDP/site identifier or observation can authorize an action. */
export function createOriginalVMDiagnostics() {
  const budget = createDiagnosticsBudget();
  return Object.freeze({
    open() {
      const owner = budget.reserve(),
        origin = performance.now();
      let entries = [],
        sequence = 0,
        dropped = 0,
        correlationDropped = 0,
        lastDropped = 0,
        lastCorrelationDropped = 0,
        terminal = owner ? 'none' : 'ownerCapacity',
        retired = false,
        start = 0;
      const offset = () => Math.max(0, Math.floor(performance.now() - origin));
      return Object.freeze({
        observe(value) {
          validateOriginalGuestDiagnostic(value);
          if (retired) return;
          if (value.event === 'diagnostic-loss') {
            if (value.dropped < lastDropped || value.correlationDropped < lastCorrelationDropped)
              throw new Error('VM_DIAGNOSTIC_COUNTER_REGRESSION');
            dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + value.dropped - lastDropped);
            correlationDropped = Math.min(
              Number.MAX_SAFE_INTEGER,
              correlationDropped + value.correlationDropped - lastCorrelationDropped
            );
            lastDropped = value.dropped;
            lastCorrelationDropped = value.correlationDropped;
            return;
          }
          if (sequence === Number.MAX_SAFE_INTEGER) {
            terminal = 'counterExhausted';
            return;
          }
          sequence++;
          if (!owner || terminal !== 'none') {
            dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
            return;
          }
          const entry = { sequence, atOffsetMs: offset(), category: value.category };
          for (const key of fields[value.category]) entry[key] = value[key];
          const bytes = Buffer.byteLength(JSON.stringify(entry));
          if (!budget.commit(owner, { entryBytes: bytes })) {
            dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
            return;
          }
          entries.push(Object.freeze(entry));
        },
        clear() {
          entries = [];
          dropped = 0;
          correlationDropped = 0;
          start = offset();
          if (owner) budget.clear(owner);
        },
        summary(binding) {
          if (retired) throw new Error('VM_DIAGNOSTIC_RETIRED');
          return Object.freeze({
            binding,
            interval: Object.freeze({ startOffsetMs: start, endOffsetMs: offset() }),
            entries: Object.freeze([...entries]),
            counts: Object.freeze({
              dropped,
              truncated: 0,
              correlationDropped,
              unmatchedCallbacks: 0,
            }),
            terminal,
            lastAccountedSequence: sequence,
            subsequentEventsUncounted: terminal !== 'none',
          });
        },
        retire() {
          if (retired) return;
          retired = true;
          entries = [];
          if (owner) budget.discard(owner);
        },
      });
    },
  });
}
