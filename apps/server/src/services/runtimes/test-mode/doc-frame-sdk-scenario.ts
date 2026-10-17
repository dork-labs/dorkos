/** Fixed HTML fixture and step-gated model-free driver; only test boot installs its probe. */
import fs from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScenarioFn } from './scenario-store.js';
import type { DocFrameSdkProbe, DocFrameSdkReady } from './doc-frame-sdk-probe.js';

let probe: DocFrameSdkProbe | undefined;
/** Boot-only installation; neither the page nor a test request can provide authority ports. */
export function configureDocFrameSdkProbe(next: DocFrameSdkProbe | undefined): void {
  probe = next;
}

/** The page consumes the installed SDK; no copied shim, principal, grant or receipt. */
export const DOC_FRAME_SDK_FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>SDK receipt fixture</title></head>
<body><button id="emit" type="button">Record fixture event</button><output id="status">waiting</output>
<script>
const status = document.getElementById('status');
const sdk = window.dorkos && window.dorkos.channel;
if (sdk) {
  status.textContent = sdk.status;
  sdk.on('status', value => { status.textContent = value; });
  document.getElementById('emit').addEventListener('click', async () => {
    const id = crypto.randomUUID();
    const payload = { text: 'Original SDK fixture bytes.' };
    document.getElementById('emit').disabled = true;
    try {
      const receipt = await sdk.emit('fixture.changed', payload, { id });
      status.textContent = JSON.stringify({ id, payload, receipt });
    } catch (error) { status.textContent = 'not confirmed'; }
  });
} else { status.textContent = 'SDK unavailable'; }
</script></body></html>`;

/** Driver of the running boot's genuine managed MCP workflow, held until real browser checks finish. */
export const docFrameSdkScenario: ScenarioFn = async function* (_content, ctx, opts) {
  const installed = probe;
  if (!installed) throw new Error('The original-boot Doc SDK probe is unavailable.');
  ctx.signal.throwIfAborted();
  if (!opts?.cwd)
    throw new Error('The Doc SDK fixture needs its actual registered agent directory.');
  const cwd = await fs.realpath(opts.cwd);
  const parent = join(cwd, '.dork');
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  const parentWithin = relative(cwd, realParent);
  if (parentWithin.startsWith('..') || isAbsolute(parentWithin))
    throw new Error('The Doc SDK fixture directory leaves its agent.');
  const directory = join(realParent, 'doc-sdk-fixture');
  await fs.mkdir(directory, { recursive: true });
  const confined = await fs.realpath(directory);
  const within = relative(cwd, confined);
  if (within.startsWith('..') || isAbsolute(within))
    throw new Error('The Doc SDK fixture directory leaves its agent.');
  const sourcePath = join(confined, `sdk-${randomUUID()}.html`);
  ctx.signal.throwIfAborted();
  await fs.writeFile(sourcePath, DOC_FRAME_SDK_FIXTURE_HTML, { flag: 'wx', mode: 0o600 });
  let ready!: (value: DocFrameSdkReady) => void;
  const announced = new Promise<DocFrameSdkReady>((resolve) => {
    ready = resolve;
  });
  const controller = new AbortController();
  const stop = () => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', stop, { once: true });
  if (ctx.signal.aborted) stop();
  const work = installed({
    sessionId: ctx.sessionId,
    agentPath: cwd,
    sourcePath,
    signal: controller.signal,
    onReady: ready,
    waitForBrowser: () => ctx.awaitStep(),
  });
  // Handle setup rejection immediately; a readiness wait must never hang over a failed workflow.
  const failed = work.then<never>(() => {
    throw new Error('The Doc SDK fixture ended before readiness.');
  });
  void failed.catch(() => {});
  try {
    const value = await Promise.race([announced, failed]);
    yield {
      type: 'text_delta',
      data: { text: `SDK fixture ready: ${value.documentId}; verified-opener log only.` },
    };
    await work;
    yield { type: 'done', data: { sessionId: ctx.sessionId } };
  } finally {
    // The original seeded-home cleanup owns this HTML after frame unmount/final child EOF.
    // Never unlink it while a retained page or the managed workflow might still reference it.
    controller.abort(new Error('The Doc SDK scenario ended.'));
    ctx.signal.removeEventListener('abort', stop);
    await work;
  }
};
