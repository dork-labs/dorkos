/**
 * The visual companion's page-to-agent flow, model-free: open a served page and
 * a dev-server preview with an `agent:owner` route, approve it as the opener,
 * then answer the turn a page event starts by echoing the `doc_events` it got.
 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { ScenarioFn } from '../scenario-store.js';
import type { DocFrameSdkWorkflow } from './doc-frame-sdk-probe.js';
import { installedDocFrameSdkProbe, writeFixturePage } from './doc-frame-sdk-scenario.js';

/**
 * The route the visual companion declares: its page emits `companion.*` events
 * (`companion.review.send` and the like), and a burst of them wakes the agent
 * that opened the page once. `companion.*` matches every type under the prefix.
 * It routes to the opener itself and asks for no write, so the opener approves
 * it alone (`verified_opener`); no person is asked.
 */
export const COMPANION_ROUTE = {
  id: 'companion',
  on: 'companion.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 20 },
} as const;

/** What the routed turn says, so a browser test can read the context it was handed. */
export const COMPANION_DOC_TURN_PREFIX = 'Companion doc turn:';

/** The page both copies serve: the same `companion.review.send` the companion emits. */
export const COMPANION_PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Companion fixture</title></head>
<body><button id="send" type="button">Send choice</button>
<output id="status">waiting</output><output id="receipt"></output>
<script>
const status = document.getElementById('status');
const receipt = document.getElementById('receipt');
const channel = window.dorkos && window.dorkos.channel;
const show = () => { status.textContent = channel ? channel.status : 'absent'; };
if (channel) channel.on('status', show);
show();
document.getElementById('send').addEventListener('click', async () => {
  if (!channel || channel.status !== 'ready') { receipt.textContent = 'not ready'; return; }
  const ev = { message: 'Pick b', notes: [{ n: 1, text: 'b' }], screen: 'layout', where: location.protocol };
  try {
    receipt.textContent = JSON.stringify(await channel.emit('companion.review.send', ev));
  } catch (error) { receipt.textContent = 'refused ' + error.outcome; }
});
</script></body></html>`;

const openedSchema = z.object({ success: z.literal(true), documentId: z.string().min(1) });
const grantedSchema = z.object({ kind: z.literal('granted'), grantId: z.string().min(1) });
const configuredSchema = z.object({ configured: z.literal(true) });

/**
 * The two pages, then their routes, exactly as the designer agent does it: open
 * each page, declare its route, and approve that route as its opener — after
 * the browser has looked at the pages with no route at all.
 */
function companionWorkflow(
  servedPath: string,
  previewUrl: string,
  say: (text: string) => void
): DocFrameSdkWorkflow {
  return async ({ call, grant, waitForBrowser }) => {
    const channel = { routes: [COMPANION_ROUTE] };
    const opened = [];
    for (const url of [servedPath, previewUrl])
      opened.push(
        openedSchema.parse(await call('control_ui', { action: 'browser_navigate', url }))
      );
    say(`Companion pages open: ${opened.map((page) => page.documentId).join(' ')}.`);
    // The browser checks the pages before any route exists, then steps this turn on.
    await waitForBrowser();
    for (const page of opened) {
      configuredSchema.parse(
        await call('configure_doc_channel', { documentId: page.documentId, channel })
      );
      const granted = grantedSchema.parse(
        await call('approve_doc_route', {
          documentId: page.documentId,
          routeId: COMPANION_ROUTE.id,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        })
      );
      // The opener's own route needs no person: anything else here is a failure.
      const stored = grant(granted.grantId);
      if (
        stored?.documentId !== page.documentId ||
        stored.approvalId !== null ||
        (stored.approvalEvidence as { kind?: string } | null)?.kind !== 'verified_opener'
      )
        throw new Error('The companion route was not granted to its verified opener.');
    }
    say('Companion routes approved.');
  };
}

/** Setup turn opens and approves; a turn started by a page event echoes its context. */
export const docFrameCompanionScenario: ScenarioFn = async function* (content, ctx, opts) {
  if (ctx.docEventsPrompt) {
    yield {
      type: 'text_delta',
      data: { text: `${COMPANION_DOC_TURN_PREFIX}\n\n${ctx.docEventsPrompt}` },
    };
    yield { type: 'done', data: { sessionId: ctx.sessionId } };
    return;
  }
  const probe = installedDocFrameSdkProbe();
  if (!probe) throw new Error('The original-boot Doc SDK probe is unavailable.');
  if (!opts?.cwd) throw new Error('The companion fixture needs its registered agent directory.');
  const previewUrl = /http:\/\/(?:localhost|127\.0\.0\.1):\d+\/\S*/.exec(content)?.[0];
  if (!previewUrl) throw new Error('Name the companion dev server URL in the message.');
  const agentPath = await fs.realpath(opts.cwd);
  const servedPath = await writeFixturePage(agentPath, COMPANION_PAGE_HTML, ctx.signal);

  const said: string[] = [];
  let wake: (() => void) | null = null;
  const say = (text: string) => {
    said.push(text);
    wake?.();
  };
  let finished = false;
  const work = probe({
    sessionId: ctx.sessionId,
    agentPath,
    sourcePath: servedPath,
    signal: ctx.signal,
    onReady: () => {},
    waitForBrowser: () => ctx.awaitStep(),
    workflow: companionWorkflow(servedPath, previewUrl, say),
  });
  const settled = work.then(
    () => undefined,
    () => undefined
  );
  void settled.then(() => {
    finished = true;
    wake?.();
  });
  for (;;) {
    while (said.length > 0) yield { type: 'text_delta', data: { text: `${said.shift()}\n\n` } };
    if (finished) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = null;
  }
  // Surfaces a workflow failure as this turn's failure.
  await work;
  yield { type: 'done', data: { sessionId: ctx.sessionId } };
};
