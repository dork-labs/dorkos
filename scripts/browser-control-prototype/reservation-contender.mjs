import { BrowserManager } from './manager.mjs';
import { loadPlaywright } from './runtime.mjs';

let resource;
let configured;
let busy = false;
const send = (value) => process.send?.(value);
process.on('message', async (message) => {
  if (busy) return;
  busy = true;
  try {
    if (message.type === 'configure') {
      configured = message;
      send({ type: 'ready' });
    } else if (message.type === 'open') {
      if (configured.mode === 'browser') {
        const runtime = await loadPlaywright({ repoRoot: configured.repoRoot });
        resource = new BrowserManager({
          profilesDir: configured.profilesDir,
          fixtureOrigin: configured.fixtureOrigin,
          runtime,
        });
        const browser = await resource.openPersistent(configured.profileId);
        send({ type: 'holder', process: resource.ownedProcess(browser.browserId) });
      } else {
        const { reserveProfile } = await import(configured.reservationModule);
        resource = reserveProfile(configured.profilesDir, configured.profileId);
        resource.createDirectory();
        send({ type: 'holder' });
      }
    } else if (message.type === 'close') {
      if (configured.mode === 'browser') await resource?.shutdown();
      else resource?.release();
      resource = null;
      send({ type: 'closed' });
      process.disconnect();
    }
  } catch (error) {
    // Fixed codes only: never forward runtime errors containing local paths or state.
    send({
      type: 'refused',
      code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'CHILD_ERROR',
    });
  } finally {
    busy = false;
  }
});
process.on('disconnect', async () => {
  // Unexpected parent loss cleans resources; deliberate SIGKILL still exercises crash recovery.
  try {
    if (configured?.mode === 'browser') await resource?.shutdown();
    else resource?.release();
    process.exit(0);
  } catch {
    process.exit(1);
  }
});
