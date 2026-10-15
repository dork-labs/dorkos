import { requireOriginalWorkerEntry } from './server.js';
import { startNativeConsumerFixture } from './server-native-fixture.js';
import { createOriginalWorkerResourceData } from './server-worker/server-worker-resource-data.js';
import { startOriginalWorkerResources } from './server-worker/server-worker-bootstrap.js';
import { writeSync } from 'node:fs';
import { handleOriginalWorkerMessage0 } from './server-worker/server-worker-room-and-data.js';
import { handleOriginalWorkerMessage1 } from './server-worker/server-worker-room-and-data.js';
import { handleOriginalWorkerMessage2 } from './server-worker/server-worker-room-and-data.js';
import { handleOriginalWorkerMessage3 } from './server-worker/server-worker-file-actions.js';
import { handleOriginalWorkerMessage4 } from './server-worker/server-worker-file-actions.js';
import { handleOriginalWorkerMessage5 } from './server-worker/server-worker-file-actions.js';
import { handleOriginalWorkerMessage6 } from './server-worker/server-worker-file-actions.js';
import { handleOriginalWorkerMessage7 } from './server-worker/server-worker-widget-and-retirement.js';
import { handleOriginalWorkerMessage8 } from './server-worker/server-worker-widget-and-retirement.js';
import { handleOriginalWorkerMessage9 } from './server-worker/server-worker-widget-and-retirement.js';
type WorkerContext = ReturnType<typeof captureOriginalWorkerContext>;
const workerOwners = new WeakMap<object, WorkerContext>();
const originalGet = WeakMap.prototype.get,
  originalSet = WeakMap.prototype.set,
  originalApply = Reflect.apply;
/** Only a constructor-private operation key selects the original resource and action cells. */
export function requireOriginalWorkerOperations(key: object): WorkerContext {
  const context = originalApply(originalGet, workerOwners, [key]) as WorkerContext | undefined;
  if (!context) throw new Error('Original worker operation owner required');
  return context;
}
function captureOriginalWorkerContext(entryKey: object) {
  const { postCloseResources } = createOriginalWorkerResourceData(entryKey);
  let postCloseWitnessInstalled = false;
  let fixture: Awaited<ReturnType<typeof startNativeConsumerFixture>> | undefined;
  let vite: { close(): Promise<void>; resolvedUrls: { local: string[] } | null } | undefined;
  let previews: { close(): Promise<void> } | undefined;
  let joinViteStartup: (() => Promise<void>) | undefined;
  let retired = false;
  let retirement: Promise<void> | undefined;
  let canonicalActionWork: Promise<void> | undefined;
  let canonicalActionFailure: { cause: unknown } | undefined;
  let scenarioReadCount = 0,
    scenarioReadPending = false;
  // A close received while an owning constructor is awaiting its resource
  // must drain that eventual resource too. Settlement is not a timeout.
  let savedActionSequence = 0,
    savedActionPending = false;
  let savedActionWork: Promise<void> | undefined;
  let savedActionFailure: { cause: unknown } | undefined;
  let selectionActionSequence = 0,
    selectionActionPending = false;
  let selectionActionWork: Promise<void> | undefined;
  let reviewedActionWork: Promise<void> | undefined;
  let reviewedActionFailure: { cause: unknown } | undefined;
  let reviewedActionSequence = 0,
    reviewedActionPending = false;
  let selectionActionFailure: { cause: unknown } | undefined;
  let mcpActionSequence = 0,
    mcpActionPending = false;
  let mcpActionWork: Promise<void> | undefined;
  let mcpActionFailure: { cause: unknown } | undefined;
  let widgetActionCount = 0,
    widgetActionPending = false;
  let widgetActionWork: Promise<void> | undefined;
  let widgetActionFailure: { cause: unknown } | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const close = () => {
    if (retirement) return retirement;
    retired = true;
    retirement = (async () => {
      let closeDiagnosticSequence = 0;
      const closeData = (phase: string, state: 'begin' | 'done' | 'failed') => {
        if (closeDiagnosticSequence >= 40) return;
        try {
          writeSync(
            2,
            `ORIGINAL_MCP_CLOSE_STAGE child ${++closeDiagnosticSequence} ${Date.now()} ${phase} ${state}\n`
          );
        } catch {
          // Diagnostic DATA cannot replace the original owning close result.
        }
      };
      closeData('startup', 'begin');
      await startupSettled;
      closeData('startup', 'done');
      let failed = false,
        first: unknown;
      const remember = (cause: unknown) => {
        if (!failed) {
          failed = true;
          first = cause;
        }
      };
      const priorActionFailure =
        mcpActionFailure ??
        canonicalActionFailure ??
        widgetActionFailure ??
        selectionActionFailure ??
        savedActionFailure ??
        reviewedActionFailure;
      if (priorActionFailure) remember(priorActionFailure.cause);
      const drain = async (phase: string, run: () => unknown) => {
        closeData(phase, 'begin');
        try {
          await run();
          closeData(phase, 'done');
        } catch (cause) {
          closeData(phase, 'failed');
          remember(cause);
        }
      };
      // Initiate actual pump cancellation before joining an action that may await that pump.
      await drain('reviewed-stop', () => fixture?.native.stopOriginalReviewedReplay());
      if (reviewedActionWork) await drain('reviewed-join', () => reviewedActionWork);
      await drain('saved-stop', () => fixture?.native.stopOriginalSavedDispatch());
      if (savedActionWork) await drain('saved-join', () => savedActionWork);
      await drain('selection-stop', () => fixture?.native.stopOriginalSelectionDispatch());
      if (selectionActionWork) await drain('selection-join', () => selectionActionWork);
      await drain('mcp-stop', () => fixture?.native.stopOriginalMcpAppDispatch());
      if (mcpActionWork) await drain('mcp-join', () => mcpActionWork);
      if (widgetActionWork) await drain('widget-join', () => widgetActionWork);
      if (canonicalActionWork) await drain('canonical-join', () => canonicalActionWork);
      const actionFailure =
        mcpActionFailure ??
        canonicalActionFailure ??
        widgetActionFailure ??
        selectionActionFailure ??
        savedActionFailure ??
        reviewedActionFailure;
      if (actionFailure) remember(actionFailure.cause);
      await drain('vite-close', () => vite?.close());
      await drain('previews-close', () => previews?.close());
      await drain('fixture-close', () => fixture?.close());
      closeData('complete', failed ? 'failed' : 'done');
      if (failed) throw first;
    })();
    return retirement;
  };
  return {
    get fixture() {
      return fixture;
    },
    set fixture(value: typeof fixture) {
      fixture = value;
    },
    get vite() {
      return vite;
    },
    set vite(value: typeof vite) {
      vite = value;
    },
    get previews() {
      return previews;
    },
    set previews(value: typeof previews) {
      previews = value;
    },
    get joinViteStartup() {
      return joinViteStartup;
    },
    set joinViteStartup(value: typeof joinViteStartup) {
      joinViteStartup = value;
    },
    get retired() {
      return retired;
    },
    set retired(value: typeof retired) {
      retired = value;
    },
    get retirement() {
      return retirement;
    },
    set retirement(value: typeof retirement) {
      retirement = value;
    },
    get canonicalActionWork() {
      return canonicalActionWork;
    },
    set canonicalActionWork(value: typeof canonicalActionWork) {
      canonicalActionWork = value;
    },
    get canonicalActionFailure() {
      return canonicalActionFailure;
    },
    set canonicalActionFailure(value: typeof canonicalActionFailure) {
      canonicalActionFailure = value;
    },
    get scenarioReadCount() {
      return scenarioReadCount;
    },
    set scenarioReadCount(value: typeof scenarioReadCount) {
      scenarioReadCount = value;
    },
    get scenarioReadPending() {
      return scenarioReadPending;
    },
    set scenarioReadPending(value: typeof scenarioReadPending) {
      scenarioReadPending = value;
    },
    get savedActionSequence() {
      return savedActionSequence;
    },
    set savedActionSequence(value: typeof savedActionSequence) {
      savedActionSequence = value;
    },
    get savedActionPending() {
      return savedActionPending;
    },
    set savedActionPending(value: typeof savedActionPending) {
      savedActionPending = value;
    },
    get savedActionWork() {
      return savedActionWork;
    },
    set savedActionWork(value: typeof savedActionWork) {
      savedActionWork = value;
    },
    get savedActionFailure() {
      return savedActionFailure;
    },
    set savedActionFailure(value: typeof savedActionFailure) {
      savedActionFailure = value;
    },
    get selectionActionSequence() {
      return selectionActionSequence;
    },
    set selectionActionSequence(value: typeof selectionActionSequence) {
      selectionActionSequence = value;
    },
    get selectionActionPending() {
      return selectionActionPending;
    },
    set selectionActionPending(value: typeof selectionActionPending) {
      selectionActionPending = value;
    },
    get selectionActionWork() {
      return selectionActionWork;
    },
    set selectionActionWork(value: typeof selectionActionWork) {
      selectionActionWork = value;
    },
    get reviewedActionWork() {
      return reviewedActionWork;
    },
    set reviewedActionWork(value: typeof reviewedActionWork) {
      reviewedActionWork = value;
    },
    get reviewedActionFailure() {
      return reviewedActionFailure;
    },
    set reviewedActionFailure(value: typeof reviewedActionFailure) {
      reviewedActionFailure = value;
    },
    get reviewedActionSequence() {
      return reviewedActionSequence;
    },
    set reviewedActionSequence(value: typeof reviewedActionSequence) {
      reviewedActionSequence = value;
    },
    get reviewedActionPending() {
      return reviewedActionPending;
    },
    set reviewedActionPending(value: typeof reviewedActionPending) {
      reviewedActionPending = value;
    },
    get selectionActionFailure() {
      return selectionActionFailure;
    },
    set selectionActionFailure(value: typeof selectionActionFailure) {
      selectionActionFailure = value;
    },
    get mcpActionSequence() {
      return mcpActionSequence;
    },
    set mcpActionSequence(value: typeof mcpActionSequence) {
      mcpActionSequence = value;
    },
    get mcpActionPending() {
      return mcpActionPending;
    },
    set mcpActionPending(value: typeof mcpActionPending) {
      mcpActionPending = value;
    },
    get mcpActionWork() {
      return mcpActionWork;
    },
    set mcpActionWork(value: typeof mcpActionWork) {
      mcpActionWork = value;
    },
    get mcpActionFailure() {
      return mcpActionFailure;
    },
    set mcpActionFailure(value: typeof mcpActionFailure) {
      mcpActionFailure = value;
    },
    get widgetActionCount() {
      return widgetActionCount;
    },
    set widgetActionCount(value: typeof widgetActionCount) {
      widgetActionCount = value;
    },
    get widgetActionPending() {
      return widgetActionPending;
    },
    set widgetActionPending(value: typeof widgetActionPending) {
      widgetActionPending = value;
    },
    get widgetActionWork() {
      return widgetActionWork;
    },
    set widgetActionWork(value: typeof widgetActionWork) {
      widgetActionWork = value;
    },
    get widgetActionFailure() {
      return widgetActionFailure;
    },
    set widgetActionFailure(value: typeof widgetActionFailure) {
      widgetActionFailure = value;
    },
    get postCloseWitnessInstalled() {
      return postCloseWitnessInstalled;
    },
    set postCloseWitnessInstalled(value: typeof postCloseWitnessInstalled) {
      postCloseWitnessInstalled = value;
    },
    close,
    settleStartup,
    postCloseResources,
  };
}
/** Child-entry and resource operation keys are distinct and never exposed. */
export async function runOriginalNativeConsumerWorker(entryKey: object) {
  requireOriginalWorkerEntry(entryKey);
  const context = captureOriginalWorkerContext(entryKey);
  const operationKey = Object.freeze({});
  originalApply(originalSet, workerOwners, [operationKey, context]);
  process.on('message', (message: unknown) => {
    if (handleOriginalWorkerMessage0(operationKey, message)) return;
    if (handleOriginalWorkerMessage1(operationKey, message)) return;
    if (handleOriginalWorkerMessage2(operationKey, message)) return;
    if (handleOriginalWorkerMessage3(operationKey, message)) return;
    if (handleOriginalWorkerMessage4(operationKey, message)) return;
    if (handleOriginalWorkerMessage5(operationKey, message)) return;
    if (handleOriginalWorkerMessage6(operationKey, message)) return;
    if (handleOriginalWorkerMessage7(operationKey, message)) return;
    if (handleOriginalWorkerMessage8(operationKey, message)) return;
    if (handleOriginalWorkerMessage9(operationKey, message)) return;
  });

  process.once('disconnect', () => {
    void context.close().catch(() => {
      process.exitCode = 1;
    });
  });
  await startOriginalWorkerResources(operationKey);
}
