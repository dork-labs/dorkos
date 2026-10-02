import process from 'node:process';
import { createBrowserEngine } from '../../dist/index.js';
import { configuration, requestId, profileId } from './lifecycle-fixture.ts';
let engine;
process.on('message', async (message) => {
  if (message.kind === 'open') {
    try {
      engine = createBrowserEngine(await configuration(message.dataDir, message.origin, true));
      const opened = await engine.open({ kind: 'open', requestId, mode: 'persistent', profileId });
      process.send({ kind: 'opened', opened });
    } catch (error) {
      process.send({ kind: 'refused', code: error.code });
    }
  } else if (message.kind === 'stop') {
    const results = (await engine?.shutdown()) ?? [];
    process.send({ kind: 'stopped', results }, () => process.disconnect());
  }
});
process.send({ kind: 'ready' });
