import type { Page } from 'playwright-core';
import type { BrowserBinding } from '../contracts.js';
import { sameBinding } from '../input/binding.js';
import type { DiagnosticsBudget } from './diagnostics-budget.js';
/** Strict scalar diagnostics, without website strings or raw SDK objects. */
export interface DiagnosticEntry {
  sequence: number;
  atOffsetMs: number;
  category: 'console' | 'error' | 'network' | 'lifecycle';
  severity?: 'debug' | 'info' | 'warning' | 'error' | 'unknown';
  requestId?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'other' | 'unknown';
  resource?:
    'document' | 'script' | 'style' | 'image' | 'font' | 'fetch' | 'media' | 'other' | 'unknown';
  status?: 'informational' | 'success' | 'redirect' | 'clientError' | 'serverError' | 'unknown';
  duration?: 'under100ms' | 'under1s' | 'under10s' | 'atLeast10s' | 'unknown';
}
/** Returned scalar copies belong to the caller; internal retained history remains charged. */
export interface DiagnosticSummary {
  binding: BrowserBinding;
  interval: { startOffsetMs: number; endOffsetMs: number };
  entries: DiagnosticEntry[];
  counts: {
    dropped: number;
    truncated: number;
    correlationDropped: number;
    unmatchedCallbacks: number;
  };
  terminal: 'none' | 'counterExhausted' | 'observerUnavailable' | 'ownerCapacity';
  lastAccountedSequence: number;
  subsequentEventsUncounted: boolean;
}
/** Local cleanup does not prove Page listener removal or native/profile disappearance. */
export interface DiagnosticsOwner {
  install(page: Page): void;
  replaceEpoch(): void;
  discard(): void;
  read(): DiagnosticSummary | null;
  cleanupUnavailable(): boolean;
}
/** One engine constant sentinel; a refused tab allocates no owner/history/listeners. */
export const unavailableDiagnostics: DiagnosticsOwner = Object.freeze({
  install() {},
  replaceEpoch() {},
  discard() {},
  read: () => null,
  cleanupUnavailable: () => false,
});
interface Correlation {
  ref: string;
  startBinding: BrowserBinding;
  startOffsetMs: number;
  method: DiagnosticEntry['method'];
  resource: DiagnosticEntry['resource'];
  status?: DiagnosticEntry['status'];
  charge: number;
}
const charge = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length + 1;
function invoke(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') throw new Error('DIAGNOSTIC_OBSERVATION_REFUSED');
  const fn = (value as Record<string, unknown>)[key];
  if (typeof fn !== 'function') throw new Error('DIAGNOSTIC_OBSERVATION_REFUSED');
  return Reflect.apply(fn, value, []);
}
const method = (value: unknown): DiagnosticEntry['method'] =>
  typeof value === 'string' &&
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value)
    ? (value as DiagnosticEntry['method'])
    : 'unknown';
function resource(value: unknown): DiagnosticEntry['resource'] {
  if (value === 'stylesheet') return 'style';
  return typeof value === 'string' &&
    ['document', 'script', 'style', 'image', 'font', 'fetch', 'media'].includes(value)
    ? (value as DiagnosticEntry['resource'])
    : 'unknown';
}

function status(value: unknown): DiagnosticEntry['status'] {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599)
    return 'unknown';
  return (['informational', 'success', 'redirect', 'clientError', 'serverError'] as const)[
    Math.floor(value / 100) - 1
  ];
}
function duration(elapsed: number): DiagnosticEntry['duration'] {
  if (elapsed < 100) return 'under100ms';
  if (elapsed < 1000) return 'under1s';
  if (elapsed < 10000) return 'under10s';
  return 'atLeast10s';
}

/** Preregister one charged epoch and fixed listener cohort before any Page getter. */
export function createDiagnosticsOwner(options: {
  budget: DiagnosticsBudget;
  readBinding(): BrowserBinding | null;
  now(): number;
}): DiagnosticsOwner {
  const token = options.budget.reserve();
  if (!token) return unavailableDiagnostics;
  // Callback closures capture only this severable cell, never an immutable Page/budget binding.
  const cell: { state: OwnerState | null; cleanupUnavailable: boolean } = {
    state: null,
    cleanupUnavailable: false,
  };
  cell.state = new OwnerState(options, token);
  const events = [
    'console',
    'pageerror',
    'request',
    'response',
    'requestfinished',
    'requestfailed',
  ] as const;
  let registrations: { event: string; callback: (value: unknown) => void }[] = [];
  let page: Page | null = null;
  const owner: DiagnosticsOwner = {
    install(target) {
      if (!cell.state || page) return;
      page = target;
      for (const event of events) {
        const callback = observerCallback(cell, event);
        registrations.push({ event, callback });
        try {
          const on = target.on;
          if (!cell.state?.live()) return;
          Reflect.apply(on, target, [event, callback]);
        } catch {
          cell.state?.unavailable();
          return;
        }
      }
    },
    replaceEpoch() {
      cell.state?.replace();
    },
    discard() {
      const state = cell.state;
      cell.state = null;
      state?.discard();
      const target = page;
      page = null;
      const slots = registrations;
      registrations = [];
      for (const slot of slots) {
        try {
          if (target) {
            const off = target.off;
            Reflect.apply(off, target, [slot.event, slot.callback]);
          }
        } catch {
          cell.cleanupUnavailable = true;
        }
      }
    },
    read: () => cell.state?.read() ?? null,
    cleanupUnavailable: () => cell.cleanupUnavailable,
  };
  return Object.freeze(owner);
}
function observerCallback(
  cell: { state: OwnerState | null },
  event: string
): (value: unknown) => void {
  return (value: unknown) => cell.state?.observe(event, value);
}
class OwnerState {
  private binding: BrowserBinding | null = null;
  private start = 0;
  private lastRaw = 0;
  private offset = 0;
  private sequence = 0;
  private reference = 0;
  private entries: DiagnosticEntry[] = [];
  private counts = { dropped: 0, truncated: 0, correlationDropped: 0, unmatchedCallbacks: 0 };
  private terminal: DiagnosticSummary['terminal'] = 'none';
  private busy = false;
  private nested = false;
  private weak = new WeakMap<object, string>();
  private correlations = new Map<string, Correlation>();
  constructor(
    private options: {
      budget: DiagnosticsBudget;
      readBinding(): BrowserBinding | null;
      now(): number;
    },
    private token: object
  ) {
    this.replace();
  }
  live(): boolean {
    return this.terminal === 'none' && this.binding !== null;
  }
  unavailable(): void {
    this.terminal = 'observerUnavailable';
    this.clearCorrelations();
  }
  private clearCorrelations(): void {
    for (const c of this.correlations.values())
      this.options.budget.releaseCorrelation(this.token, c.charge);
    this.correlations.clear();
    this.weak = new WeakMap();
  }
  replace(): void {
    if (this.busy) {
      this.nested = true;
      this.unavailable();
      return;
    }
    if (this.terminal !== 'none') return;
    this.busy = true;
    try {
      const binding = this.options.readBinding(),
        now = this.options.now();
      if (
        !binding ||
        !Number.isFinite(now) ||
        now < 0 ||
        now > Number.MAX_SAFE_INTEGER ||
        this.nested
      )
        throw Error('CLOCK_REFUSED');
      if (!sameBinding(this.options.readBinding(), binding) || this.nested)
        throw Error('BINDING_REFUSED');
      this.options.budget.clear(this.token);
      this.entries = [];
      this.correlations.clear();
      this.weak = new WeakMap();
      this.binding = Object.freeze({ ...binding });
      this.start = this.lastRaw = now;
      this.offset = this.sequence = this.reference = 0;
      this.counts = { dropped: 0, truncated: 0, correlationDropped: 0, unmatchedCallbacks: 0 };
    } catch {
      this.unavailable();
    } finally {
      this.busy = false;
    }
  }
  private current(): boolean {
    if (!this.live() || this.nested) return false;
    const captured = this.binding;
    const observed = this.options.readBinding();
    return (
      this.live() && !this.nested && this.binding === captured && sameBinding(observed, captured!)
    );
  }
  private observed(value: unknown, key: string): unknown {
    const result = invoke(value, key);
    if (!this.current()) throw Error('DIAGNOSTIC_OBSERVATION_REFUSED');
    return result;
  }
  private time(): number {
    const raw = this.options.now();
    if (!Number.isFinite(raw) || raw < this.lastRaw || raw > Number.MAX_SAFE_INTEGER || raw < 0)
      throw Error('CLOCK_REFUSED');
    const offset = Math.floor(raw - this.start);
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('CLOCK_REFUSED');
    this.lastRaw = raw;
    return offset;
  }
  private headroom(keys: (keyof OwnerState['counts'])[]): boolean {
    if (
      this.sequence >= Number.MAX_SAFE_INTEGER ||
      keys.some((k) => this.counts[k] >= Number.MAX_SAFE_INTEGER)
    ) {
      this.terminal = 'counterExhausted';
      this.clearCorrelations();
      return false;
    }
    return true;
  }
  private loss(options: { correlation?: boolean; unmatched?: boolean } = {}): void {
    const keys: (keyof OwnerState['counts'])[] = ['dropped'];
    if (options.correlation) keys.push('correlationDropped');
    if (options.unmatched) keys.push('unmatchedCallbacks');
    if (!this.current() || !this.headroom(keys)) return;
    for (const key of keys) this.counts[key]++;
  }
  observe(event: string, value: unknown): void {
    if (!this.live()) return;
    if (this.busy) {
      this.nested = true;
      return;
    }
    this.busy = true;
    try {
      if (!this.current()) return;
      const at = this.time();
      if (!this.current()) return;
      if (event === 'console' || event === 'pageerror') this.simple(event, value, at);
      else this.network(event, value, at);
      if (this.nested) this.unavailable();
    } catch {
      this.unavailable();
    } finally {
      if (this.nested) this.unavailable();
      this.busy = false;
    }
  }
  private append(
    fields: Omit<DiagnosticEntry, 'sequence' | 'atOffsetMs'>,
    at: number,
    correlation?: Correlation,
    prior?: Correlation
  ): boolean {
    if (!this.current() || !this.headroom(['truncated'])) return false;
    const entry: DiagnosticEntry = { sequence: this.sequence + 1, atOffsetMs: at, ...fields };
    const omitted =
      fields.category === 'network'
        ? Number(fields.status === undefined) + Number(fields.duration === undefined)
        : 0;
    if (this.counts.truncated > Number.MAX_SAFE_INTEGER - omitted) {
      this.terminal = 'counterExhausted';
      this.clearCorrelations();
      return false;
    }
    if (
      !this.options.budget.commit(this.token, {
        entryBytes: charge({ binding: this.binding, entry }),
        ...(correlation
          ? {
              correlationBytes: correlation.charge,
              ...(prior ? { priorCorrelationBytes: prior.charge } : {}),
            }
          : {}),
      })
    ) {
      this.loss({
        correlation:
          !!correlation &&
          !prior &&
          !this.options.budget.correlationFits(this.token, correlation.charge),
      });
      return false;
    }
    this.entries.push(entry);
    this.sequence++;
    this.offset = at;
    this.counts.truncated += omitted;
    return true;
  }
  private simple(event: string, value: unknown, at: number): void {
    const severity = event === 'pageerror' ? 'error' : this.observed(value, 'type');
    const fixed = ['debug', 'info', 'warning', 'error'].includes(
      String(typeof severity === 'string' ? severity : 'unknown')
    )
      ? (severity as DiagnosticEntry['severity'])
      : 'unknown';
    this.append({ category: event === 'console' ? 'console' : 'error', severity: fixed }, at);
  }
  private network(event: string, value: unknown, at: number): void {
    const request = event === 'response' ? this.observed(value, 'request') : value;
    if (!request || typeof request !== 'object') throw Error('REQUEST_REFUSED');
    const ref = this.weak.get(request),
      prior = ref ? this.correlations.get(ref) : undefined;
    if (event === 'request') {
      this.startRequest(request, prior, at);
      return;
    }
    this.continueRequest({ event, value, request, prior, at });
  }
  private startRequest(request: object, prior: Correlation | undefined, at: number): void {
    if (prior) {
      this.loss({ correlation: true });
      return;
    }
    if (this.reference >= Number.MAX_SAFE_INTEGER) {
      this.terminal = 'counterExhausted';
      this.clearCorrelations();
      return;
    }
    const c: Correlation = {
      ref: `request_${String(this.reference + 1).padStart(16, '0')}`,
      startBinding: this.binding!,
      startOffsetMs: at,
      method: method(this.observed(request, 'method')),
      resource: resource(this.observed(request, 'resourceType')),
      charge: 0,
    };
    c.charge = charge({
      ref: c.ref,
      startBinding: c.startBinding,
      startOffsetMs: at,
      method: c.method,
      resource: c.resource,
    });
    if (
      this.append(
        {
          category: 'network',
          requestId: c.ref,
          method: c.method,
          resource: c.resource,
          duration: duration(0),
        },
        at,
        c
      )
    ) {
      this.reference++;
      this.correlations.set(c.ref, c);
      this.weak.set(request, c.ref);
    }
  }
  private continueRequest(options: {
    event: string;
    value: unknown;
    request: object;
    prior: Correlation | undefined;
    at: number;
  }): void {
    const { event, value, request, prior, at } = options;
    if (!prior) {
      this.loss({ unmatched: true });
      return;
    }
    if (event !== 'response') {
      this.correlations.delete(prior.ref);
      this.weak.delete(request);
      this.options.budget.releaseCorrelation(this.token, prior.charge);
    }
    const fixedStatus =
      event === 'response' ? status(this.observed(value, 'status')) : prior.status;
    const fields = {
      category: 'network' as const,
      requestId: prior.ref,
      method: prior.method,
      resource: prior.resource,
      ...(fixedStatus ? { status: fixedStatus } : {}),
      duration: duration(at - prior.startOffsetMs),
    };
    if (event === 'response') {
      const changed = { ...prior, status: fixedStatus };
      const { charge: _charge, ...scalar } = changed;
      changed.charge = charge(scalar);
      if (this.append(fields, at, changed, prior)) this.correlations.set(prior.ref, changed);
    } else this.append(fields, at);
  }
  read(): DiagnosticSummary | null {
    if (!this.binding) return null;
    return {
      binding: { ...this.binding },
      interval: { startOffsetMs: 0, endOffsetMs: this.offset },
      entries: this.entries.map((e) => ({ ...e })),
      counts: { ...this.counts },
      terminal: this.terminal,
      lastAccountedSequence: this.sequence,
      subsequentEventsUncounted: this.terminal !== 'none',
    };
  }
  discard(): void {
    this.entries = [];
    this.correlations.clear();
    this.weak = new WeakMap();
    this.binding = null;
    this.options.budget.discard(this.token);
  }
}
