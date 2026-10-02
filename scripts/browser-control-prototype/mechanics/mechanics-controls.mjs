import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { delay, assertObservation, withCleanup } from './mechanics-helpers.mjs';
/** Private source mutants exercise the same probe without changing any frozen module. */
export async function mutatedControl(fault, run, { sourceText = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mechanics-control-'));
  return withCleanup(
    async () => {
      let source =
        sourceText ?? (await readFile(new URL('../control.mjs', import.meta.url), 'utf8'));
      const needle =
        fault === 'revoked-epoch'
          ? 'tab.epoch !== request.epoch'
          : "if (tab.pending >= this.#maxQueue) refuse('queue-full');";
      assert.equal(source.split(needle).length, 2, 'MUTANT_ANCHOR_CHANGED');
      source = source.replace(needle, fault === 'revoked-epoch' ? 'false' : '');
      source = source.replace(
        "'./contracts.mjs'",
        JSON.stringify(new URL('../contracts.mjs', import.meta.url).href)
      );
      const file = join(directory, 'control-mutant.mjs');
      await writeFile(file, source, { mode: 0o600 });
      const { PrototypeControl } = await import(pathToFileURL(file).href);
      return await run(PrototypeControl);
    },
    () => rm(directory, { recursive: true, force: true })
  );
}
/** Missing acknowledgements must never be counted as renders, even though frame delivery succeeds. */
export async function probeRenderAck(s, { fault = false } = {}) {
  const headers = {
    Authorization: `Bearer ${s.human}`,
    Origin: s.viewer.url,
    'Content-Type': 'application/json',
  };
  async function api(path, body) {
    return fetch(s.viewer.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  const { viewerId } = await (await api('/subscribe', { tabId: s.tab.tabId })).json();
  return withCleanup(
    async () => {
      const before = s.viewer.stats().rendered;
      const frame = await api('/frame', { viewerId });
      assert.equal(frame.status, 200);
      const receipt = JSON.parse(frame.headers.get('x-frame-receipt'));
      await frame.arrayBuffer();
      const blocked = await api('/frame', { viewerId });
      assert.equal(blocked.status, 409);
      await blocked.arrayBuffer();
      assert.equal(s.viewer.stats().rendered, before);
      if (!fault) assert.equal((await api('/ack', { viewerId, receipt })).status, 200);
      await delay(80);
      assertObservation(s.viewer.stats().rendered === before + 1, 'missing-render-ack');
      return { samples: 1, measurements: [] };
    },
    async () => {
      const response = await api('/unsubscribe', { viewerId });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
  );
}
export async function wrongPage(s, run) {
  const other = await s.manager.openClean();
  const tab = s.manager.getTab(other.tabIds[0]);
  await tab.page.goto(s.fixture.url + '/?marker=WRONG-PAGE-B');
  const capture = s.manager.capture.bind(s.manager);
  s.manager.capture = async (...args) => {
    const expected = await capture(...args);
    const bytes = await tab.page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled' });
    return { receipt: { ...expected.receipt, byteLength: bytes.length }, bytes };
  };
  return withCleanup(run, () => {
    s.manager.capture = capture;
  });
}
