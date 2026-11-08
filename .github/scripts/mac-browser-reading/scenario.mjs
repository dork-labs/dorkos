/* global process */
/**
 * A scripted agent for the reading. It calls the production browser tools and
 * nothing else, and only ever moves to one of the made-up hosts.
 */
import { appendFileSync } from 'node:fs';

const ALLOWED = /^http:\/\/(both|only-http)\.example\.com\//;
const LOG = process.env.READING_CALLS;

export async function* run(
  content,
  ctx,
  opts,
  { browser, composeRegistry, createLocalBrowserDomain }
) {
  const plan = JSON.parse(content);
  const registry = composeRegistry([createLocalBrowserDomain(browser)], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    localBrowserDeps: browser,
  });
  const context = { sessionId: ctx.sessionId, ...(opts?.cwd ? { cwd: opts.cwd } : {}) };
  const record = (row) => appendFileSync(LOG, `${JSON.stringify({ tag: plan.tag, ...row })}\n`);
  const call = async (tool, input = {}) => {
    try {
      const value = await registry.invoke(`local_browser.${tool}`, input, context);
      record({ tool, ok: true, url: value?.url, snapshot: value?.snapshot?.slice(0, 200) });
      return value;
    } catch (error) {
      record({ tool, ok: false, code: error?.payload?.code ?? 'unknown' });
      return null;
    }
  };
  const seen = await call('observe');
  if (plan.navigate) {
    if (!ALLOWED.test(plan.navigate)) throw new Error(`Not a made-up host: ${plan.navigate}`);
    await call('act', {
      action: { kind: 'navigate', url: plan.navigate, revision: seen?.revision ?? 0 },
    });
  }
  yield { type: 'text_delta', data: { text: `reading ${plan.tag}` } };
  yield { type: 'done', data: { sessionId: ctx.sessionId } };
}
