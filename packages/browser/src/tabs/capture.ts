import { readJpegRaster } from './raster.js';
import { ordinaryRecord } from '../lifecycle/ownership.js';
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
  if (!ordinaryRecord(record)) throw new BrowserLifecycleError('STALE_BINDING');
  const tab = record.tabs.get(command.binding.tabId);
  if (!tab || tab.pending >= 2)
    throw new BrowserLifecycleError(tab ? 'CAPTURE_QUEUE_FULL' : 'STALE_BINDING');
  const page = tab.page;
  const valid = (): boolean => currentCapture(record, tab, command, page);
  tab.pending++;
  const previous = tab.tail;
  let release!: () => void;
  tab.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
    const capture = await acquire(config, record, tab, command, page);
    if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
    tab.captureSequence = capture.receipt.captureSequence;
    return capture;
  } finally {
    tab.pending--;
    release();
  }
}

/** The request receiver spans queue, acquisition and publication continuations. */
function currentCapture(
  record: BrowserRecord,
  tab: TabRecord,
  command: CaptureCommand,
  page: TabRecord['page']
): boolean {
  return (
    ordinaryRecord(record) &&
    record.status === 'running' &&
    !record.lifetime.gate.stopped &&
    record.tabs.get(command.binding.tabId) === tab &&
    tab.page === page &&
    !tab.stopped &&
    matches(tab.binding, command.binding)
  );
}

async function acquire(
  config: EngineConfiguration,
  record: BrowserRecord,
  tab: TabRecord,
  command: CaptureCommand,
  page: TabRecord['page']
): Promise<BrowserCapture> {
  const valid = (): boolean => currentCapture(record, tab, command, page);
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  await approved(config, command.binding);
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const pointerBefore = tab.pointer.read();
  let bytes: Uint8Array;
  try {
    const screenshot = page.screenshot;
    if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
    bytes = await deadline(
      Reflect.apply(screenshot, page, [
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
  const viewportSize = page.viewportSize;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const dimensions = Reflect.apply(viewportSize, page, []) as ReturnType<typeof viewportSize>;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  if (!dimensions || bytes.length > 2 * 1024 * 1024)
    throw new BrowserLifecycleError('CAPTURE_LIMIT');
  const width = dimensions.width;
  const height = dimensions.height;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  let raster: ReturnType<typeof readJpegRaster>;
  try {
    raster = readJpegRaster(bytes);
  } catch {
    throw new BrowserLifecycleError('CAPTURE_LIMIT');
  }
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const pointerAfter = tab.pointer.read();
  const pointer =
    !pointerAfter.terminal &&
    pointerBefore.revision === pointerAfter.revision &&
    pointerBefore.marker === pointerAfter.marker
      ? pointerBefore.marker
      : null;
  let sequence: number;
  try {
    sequence = advanceCounter(tab.captureSequence);
  } catch {
    // Fence the genuine whole-browser cell before any cleanup observer or native close.
    // The captured parent driver retains the original ends and owns exact cleanup once.
    record.lifetime.uncertain = true;
    record.lifetime.requestRetirement('engineFault');
    throw new BrowserLifecycleError('COUNTER_EXHAUSTED');
  }
  const receipt = parseBrowserResult({
    kind: 'frame',
    binding: command.binding,
    captureSequence: sequence!,
    rasterWidth: raster.width,
    rasterHeight: raster.height,
    pointer,
    width,
    height,
    byteLength: bytes.length,
    format: 'jpeg',
  }) as BrowserCapture['receipt'];
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const finalPointer = tab.pointer.read();
  if (
    finalPointer.terminal ||
    finalPointer.revision !== pointerAfter.revision ||
    finalPointer.marker !== pointerAfter.marker
  )
    receipt.pointer = null;
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  const copiedBytes = new Uint8Array(bytes);
  if (!valid()) throw new BrowserLifecycleError('STALE_BINDING');
  return Object.freeze({ receipt, bytes: copiedBytes });
}
