/** Fixed SDK DATA preload before loading the actual native constructor graph. */
import { installOriginalClaudeSdkDataObservation } from '../../../runtimes/claude-code/__tests__/room-original-claude-sdk-data.js';
const sdk = installOriginalClaudeSdkDataObservation();
let failed = false;
let first: unknown;
const remember = (cause: unknown) => {
  if (!failed) {
    failed = true;
    first = cause;
  }
};
let control:
  | Awaited<
      ReturnType<
        (typeof import('./room-original-native-defaults-control.js'))['prepareOriginalClaudeDefaultsControl']
      >
    >
  | undefined;
let running: Promise<unknown> | undefined;
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= Promise.resolve().then(async () => {
    let stop: Promise<unknown> | undefined;
    try {
      stop = control?.close();
      void stop?.catch(remember);
    } catch (cause) {
      remember(cause);
    }
    const outcomes = await Promise.allSettled([stop, running]);
    for (const result of outcomes) if (result.status === 'rejected') remember(result.reason);
    try {
      await sdk.close();
    } catch (cause) {
      remember(cause);
    }
    if (failed) {
      console.error(first);
      process.exitCode = 1;
    }
    process.disconnect?.();
  }));
process.on('disconnect', () => {
  void close();
});
process.on('message', (message: unknown) => {
  if (message === 'run' && !running && !closing) {
    running = Promise.resolve()
      .then(() => control!.run())
      .then(
        () => {
          process.send?.({ phase: 'result', ok: true });
        },
        (cause) => {
          remember(cause);
          console.error(cause);
          process.send?.({ phase: 'result', ok: false });
        }
      );
    void running.catch(remember);
  } else if (message === 'close') void close();
});
try {
  const { originalClaudeDefaultsScenarios } = await import('./room-original-defaults-scenarios.js');
  const { prepareOriginalClaudeDefaultsControl } =
    await import('./room-original-native-defaults-control.js');
  const caseName = process.argv[2];
  if (
    process.argv.length !== 3 ||
    !caseName ||
    !Object.hasOwn(originalClaudeDefaultsScenarios, caseName)
  )
    throw new Error('Unknown original execution defaults case');
  const scenario =
    originalClaudeDefaultsScenarios[caseName as keyof typeof originalClaudeDefaultsScenarios];
  control = await prepareOriginalClaudeDefaultsControl(scenario);
} catch (cause) {
  remember(cause);
  await close();
}
if (!failed && !closing) process.send?.({ phase: 'ready' });
