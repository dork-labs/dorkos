import { parseConfig } from './config.js';
import { PAID_DECISIONS_ARMED } from './decisions/settings.js';
import { createSignalHandler } from './shutdown.js';
import { MIGRATIONS_DIR, WEB_DIR } from './startup/space-root.js';
import { LiveUpdatesUnavailableError, createSpaceServer } from './startup/space-server.js';

// The image's entry. Everything the server runs is built by `createSpaceServer`; this file only
// reads the settings, picks the folders beside the build, arms the paid post checks from their
// own flag, and stops on a signal.
const space = createSpaceServer({
  config: parseConfig(process.env),
  env: process.env,
  migrationsDir: MIGRATIONS_DIR,
  webDir: WEB_DIR,
  paidDecisionsArmed: PAID_DECISIONS_ARMED,
});
try {
  await space.start();
} catch (error) {
  // Already explained in the log.
  if (error instanceof LiveUpdatesUnavailableError) process.exit(1);
  throw error;
}
const onSignal = createSignalHandler(() => space.stop());
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
