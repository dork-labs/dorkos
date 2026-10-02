import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { setupViewer as setup } from './viewer-test-setup.mjs';
import { startTestChild } from './child-startup.mjs';

test('PATH-empty startup failure cleans the fixture and exits without a leaked test child', async (t) => {
  const helper = new URL('./viewer-test-setup.mjs', import.meta.url).href;
  const code = `const {setupViewer}=await import(${JSON.stringify(helper)});const cleanup=[];let failed=false;try{await setupViewer({after:fn=>cleanup.push(fn)});}catch{failed=true;}for(const close of cleanup)await close();console.log(JSON.stringify({failed,registered:cleanup.length>0}));`;
  const start = performance.now();
  const child = startTestChild(t, ['--input-type=module', '-e', code], {
    env: { ...process.env, PATH: '' },
    timeoutMs: 4000,
  });
  const result = JSON.parse(await child.ready);
  assert.equal(result.failed, true);
  assert.equal(result.registered, true);
  let timer;
  try {
    await Promise.race([
      child.terminated,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('startup-child-leak')), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(performance.now() - start < 5000);
  assert.equal(child.child.exitCode, 0);
});

test('cleanup continues through later resources after an earlier close reports failure', async (t) => {
  const hooks = [];
  t.after(async () => {
    for (const close of hooks) await close();
  });
  const s = await setup({ after: (close) => hooks.push(close) });
  const closeFrontend = s.frontend.close.bind(s.frontend);
  s.frontend.close = async () => {
    await closeFrontend();
    throw Error('fixture-close-reported-failure');
  };
  await assert.rejects(hooks[0], AggregateError);
  assert.equal(s.viewer.stats().viewers, 0);
  assert.ok(s.manager.listBrowsers().length > 0);
  assert.ok(s.manager.listBrowsers().every((browser) => browser.status === 'stopped'));
  await assert.rejects(fetch(s.fixture.url + '/health'));
  await assert.rejects(access(s.root));
});
