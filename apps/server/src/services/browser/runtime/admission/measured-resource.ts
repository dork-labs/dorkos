/** Constructor-supplied reviewed limits; no HTTP/config value can mint this policy. */
export interface MeasuredBrowserResourceEnvelope {
  readonly executableSHA256: string;
  readonly profiles: number;
  readonly browsers: number;
  readonly tabsPerBrowser: number;
  readonly viewersPerBrowser: number;
  readonly captureMinimumIntervalMilliseconds: number;
  readonly maximumCPUPercent: number;
  readonly minimumAvailableMemoryBytes: number;
  readonly maximumBrowserRSSBytes: number;
  readonly maximumObservationAgeMilliseconds: number;
}
/** One genuine current host/cohort observation; incomplete observations refuse admission. */
export interface BrowserResourceObservation {
  readonly complete: boolean;
  readonly observedAtMilliseconds: number;
  readonly cpuPercent: number;
  readonly availableMemoryBytes: number;
  readonly browserRSSBytes: number;
}
/** Private constructor identity. Scalars alone do not authenticate a measured policy. */
export interface MeasuredBrowserResourceAdmission {
  readonly kind: 'measured-browser-resource-admission';
}
type Captured = Readonly<{
  tabsPerBrowser: number;
  viewersPerBrowser: number;
  captureMinimumIntervalMilliseconds: number;
  profiles(used: number): void;
  browserCount(used: number): void;
  browser(executableSHA256: string, used: number): void;
}>;
const admissions = new WeakMap<MeasuredBrowserResourceAdmission, Captured>();
const refusals = new WeakSet<object>();
function refuse(): never {
  const reason = new Error('MEASURED_RESOURCE_ADMISSION_REFUSED');
  refusals.add(reason);
  throw reason;
}
/** Identify only a refusal minted at this exact admission boundary. */
export function isMeasuredResourceAdmissionRefusal(value: unknown): boolean {
  return typeof value === 'object' && value !== null && refusals.has(value);
}
/** Capture immutable envelope and original samplers, without inventing default limits.
 * The coordinator must review the actual supported resource window before supplying
 * this constructor input. Constructing the policy does not itself qualify that window. */
export function createMeasuredBrowserResourceAdmission(options: {
  envelope: MeasuredBrowserResourceEnvelope;
  now(): number;
  observe(): BrowserResourceObservation;
}): MeasuredBrowserResourceAdmission {
  const envelope = Object.freeze({ ...options.envelope });
  const now = options.now.bind(options),
    observe = options.observe.bind(options);
  if (
    !/^[a-f0-9]{64}$/.test(envelope.executableSHA256) ||
    !Number.isSafeInteger(envelope.profiles) ||
    envelope.profiles < 1 ||
    envelope.profiles > 64 ||
    !Number.isSafeInteger(envelope.browsers) ||
    envelope.browsers < 1 ||
    envelope.browsers > 16 ||
    !Number.isSafeInteger(envelope.tabsPerBrowser) ||
    envelope.tabsPerBrowser < 1 ||
    envelope.tabsPerBrowser > 64 ||
    !Number.isSafeInteger(envelope.viewersPerBrowser) ||
    envelope.viewersPerBrowser < 1 ||
    envelope.viewersPerBrowser > 16 ||
    !Number.isFinite(envelope.captureMinimumIntervalMilliseconds) ||
    envelope.captureMinimumIntervalMilliseconds <= 0 ||
    envelope.captureMinimumIntervalMilliseconds > 2000 ||
    !Number.isFinite(envelope.maximumCPUPercent) ||
    envelope.maximumCPUPercent <= 0 ||
    envelope.maximumCPUPercent > 100 ||
    !Number.isSafeInteger(envelope.minimumAvailableMemoryBytes) ||
    envelope.minimumAvailableMemoryBytes < 0 ||
    !Number.isSafeInteger(envelope.maximumBrowserRSSBytes) ||
    envelope.maximumBrowserRSSBytes < 1 ||
    !Number.isFinite(envelope.maximumObservationAgeMilliseconds) ||
    envelope.maximumObservationAgeMilliseconds <= 0
  )
    refuse();
  const count = (used: number, limit: number) => {
    if (!Number.isSafeInteger(used) || used < 0 || used >= limit) refuse();
  };
  const identity = Object.freeze({ kind: 'measured-browser-resource-admission' as const });
  admissions.set(
    identity,
    Object.freeze({
      tabsPerBrowser: envelope.tabsPerBrowser,
      viewersPerBrowser: envelope.viewersPerBrowser,
      captureMinimumIntervalMilliseconds: envelope.captureMinimumIntervalMilliseconds,
      profiles: (used: number) => count(used, envelope.profiles),
      browserCount: (used: number) => count(used, envelope.browsers),
      browser(executableSHA256: string, used: number) {
        if (executableSHA256 !== envelope.executableSHA256) refuse();
        count(used, envelope.browsers);
        const raw = observe();
        const observed = Object.freeze({
          complete: raw.complete,
          observedAtMilliseconds: raw.observedAtMilliseconds,
          cpuPercent: raw.cpuPercent,
          availableMemoryBytes: raw.availableMemoryBytes,
          browserRSSBytes: raw.browserRSSBytes,
        });
        const current = now();
        if (
          observed.complete !== true ||
          !Number.isFinite(current) ||
          current < 0 ||
          !Number.isFinite(observed.observedAtMilliseconds) ||
          observed.observedAtMilliseconds < 0 ||
          current < observed.observedAtMilliseconds ||
          current - observed.observedAtMilliseconds > envelope.maximumObservationAgeMilliseconds ||
          !Number.isFinite(observed.cpuPercent) ||
          observed.cpuPercent < 0 ||
          observed.cpuPercent > envelope.maximumCPUPercent ||
          !Number.isSafeInteger(observed.availableMemoryBytes) ||
          observed.availableMemoryBytes < envelope.minimumAvailableMemoryBytes ||
          !Number.isSafeInteger(observed.browserRSSBytes) ||
          observed.browserRSSBytes < 0 ||
          observed.browserRSSBytes > envelope.maximumBrowserRSSBytes
        )
          refuse();
      },
    })
  );
  return identity;
}
/** WeakMap lookup precedes participant getters; a request cannot forge this constructor policy. */
export function captureMeasuredBrowserResourceAdmission(
  value: MeasuredBrowserResourceAdmission
): Captured {
  const original = admissions.get(value);
  if (!original) refuse();
  return original;
}
