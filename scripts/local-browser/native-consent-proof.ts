/** Attended qualification of an explicit installed artifact and one disposable native Chrome. */
import { parseOptions, workerOptions } from './native/options.js';
import { runNativeOuter } from './native/outer.js';
if (process.argv.includes('--custody')) {
  const { runDesktopCustody } = await import('./native/desktop-custody.js');
  await runDesktopCustody();
} else if (process.argv.includes('--worker')) {
  const options = await workerOptions();
  if (options.surface === 'cli')
    await (await import('./native/cli-worker.js')).runCliWorker(options);
  else await (await import('./native/desktop-worker.js')).runDesktopWorker(options);
  process.exit(process.exitCode ?? 0);
} else if (process.argv.includes('--execute')) await runNativeOuter(parseOptions());
else
  console.log(
    'Prepared only. Explicit --execute --surface cli|desktop --receipt is required; see scripts/local-browser/README.md.'
  );
