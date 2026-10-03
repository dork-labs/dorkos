import type { EngineConfiguration } from '../configuration.js';
import { advanceCounter } from '../counters.js';
import { parseBrowserResult, type BrowserBinding, type BrowserResult } from '../contracts.js';
import type { BrowserRecord, CaptureCommand, TabRecord } from '../lifecycle/records.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { deadline } from '../lifecycle/deadline.js';

/** Actual bytes and attributed frame metadata; consumers receive no Page or path. */
export interface BrowserCapture {
  readonly receipt: Extract<BrowserResult, { kind: 'frame' }>;
  readonly bytes: Uint8Array;
}

function matches(left: BrowserBinding, right: BrowserBinding): boolean {
  return (Object.keys(left) as (keyof BrowserBinding)[]).every((key) => left[key] === right[key]);
}

async function approved(config: EngineConfiguration, binding: BrowserBinding): Promise<void> {
  const abort = new AbortController();
  try {
    const result = await deadline(
      config.policy.authorizeAction(binding, abort.signal),
      1000,
      'POLICY_UNAVAILABLE'
    );
    if (result !== 'allowed') throw new BrowserLifecycleError('POLICY_REFUSED');
  } catch (error) {
    if (error instanceof BrowserLifecycleError) throw error;
    throw new BrowserLifecycleError('POLICY_UNAVAILABLE');
  } finally {
    abort.abort();
  }
}

/** Serialize a bounded real capture and reject any identity change while pixels are acquired. */
export async function captureTab(
  config: EngineConfiguration,
  record: BrowserRecord,
  command: CaptureCommand
): Promise<BrowserCapture> {
  const tab = record.tabs.get(command.binding.tabId);
  if (!tab || tab.pending >= 2)
    throw new BrowserLifecycleError(tab ? 'CAPTURE_QUEUE_FULL' : 'STALE_BINDING');
  tab.pending++;
  const previous = tab.tail;
  let release!: () => void;
  tab.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await acquire(config, record, tab, command);
  } finally {
    tab.pending--;
    release();
  }
}

async function acquire(
  config: EngineConfiguration,
  record: BrowserRecord,
  tab: TabRecord,
  command: CaptureCommand
): Promise<BrowserCapture> {
  const valid = (): boolean =>
    record.status === 'running' &&
    !record.lifetime.gate.stopped &&
    record.tabs.get(command.binding.tabId) === tab &&
    !tab.stopped &&
    matches(tab.binding, command.binding);
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  await approved(config, command.binding);
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  let bytes: Uint8Array;
  try {
    const screenshot = tab.page.screenshot;
    if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
    bytes = await deadline(
      Reflect.apply(screenshot, tab.page, [
        { type: 'jpeg', quality: 70, caret: 'initial', timeout: 1500 },
      ]),
      2000,
      'CAPTURE_TIMEOUT'
    );
  } catch (error) {
    if (error instanceof BrowserLifecycleError) throw error;
    throw new BrowserLifecycleError('CAPTURE_FAILED');
  }
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const viewportSize = tab.page.viewportSize;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const dimensions = Reflect.apply(viewportSize, tab.page, []) as ReturnType<typeof viewportSize>;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  if (!dimensions || bytes.length > 2 * 1024 * 1024)
    throw new BrowserLifecycleError('CAPTURE_LIMIT');
  const width = dimensions.width;
  const height = dimensions.height;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  try {
    tab.captureSequence = advanceCounter(tab.captureSequence);
  } catch {
    tab.stopped = true;
    try {
      void tab.page.close().catch(() => {});
    } catch {
      // Cleanup observation/invocation cannot replace the terminal cause or suppress retirement.
    }
    throw new BrowserLifecycleError('COUNTER_EXHAUSTED');
  }
  const receipt = parseBrowserResult({
    kind: 'frame',
    binding: command.binding,
    captureSequence: tab.captureSequence,
    width,
    height,
    byteLength: bytes.length,
    format: 'jpeg',
  }) as BrowserCapture['receipt'];
  return Object.freeze({ receipt, bytes: new Uint8Array(bytes) });
}
