/**
 * The fixture extension the ctx conformance suite runs in BOTH runtimes
 * (DOR-2686 task 4.4). It is CommonJS source, exactly what the extension
 * compiler emits for a server entry: `register(router, ctx)` keeps the ctx,
 * and `probes` drive it, each reporting what happened as data (never
 * throwing), so a test asserts outcomes the same way for either runtime.
 *
 * In the isolated leg it is loaded by the real child bootstrap and its ctx is
 * the proxy; in the in-process leg the suite evaluates the same source in the
 * test process with the real ctx. One source, so the two legs cannot test
 * different extensions.
 *
 * @module services/extensions/isolation/__tests__/fixtures/ctx-bundle
 */

/** The bundle source. */
export const CTX_BUNDLE_SOURCE = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const api = require('@dorkos/extension-api/server');

let ctx = null;
let nextId = 1;
const subs = new Map();
const events = new Map();

function describeError(e) {
  return {
    name: e && e.name,
    code: e && e.code !== undefined ? e.code : null,
    message: String(e && e.message),
    limit: e && e.limit !== undefined ? e.limit : null,
    isAgentSendError: e instanceof api.AgentSendError,
    isInboxLimitError: e instanceof api.InboxLimitError,
    hasStack: typeof (e && e.stack) === 'string' && e.stack.includes('/'),
  };
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: describeError(e) };
  }
}

function member(dotted) {
  const parts = dotted.split('.');
  const owner = parts.length === 2 ? ctx[parts[0]] : ctx;
  return { owner, fn: owner[parts[parts.length - 1]] };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = function register(router, c) {
  ctx = c;
  // An async cleanup that uses ctx twice, then says so: a stop must let all
  // of it finish before refusing calls or exiting.
  return async () => {
    await ctx.storage.saveData({ cleanup: 'first' });
    await ctx.settings.set('cleanup', 'second');
    ctx.emit('cleanup', { ran: true });
  };
};

module.exports.probes = {
  consts: () => ({
    extensionId: ctx.extensionId,
    extensionDir: ctx.extensionDir,
    dorkHome: ctx.dorkHome,
    filesDir: ctx.filesDir,
  }),
  call: (dotted, args) =>
    attempt(() => {
      const { owner, fn } = member(dotted);
      return fn.apply(owner, args || []);
    }),
  writeFile: (name, text) =>
    attempt(() => {
      fs.writeFileSync(path.join(ctx.filesDir, name), text);
      return true;
    }),
  emit: (event, data) => attempt(() => ctx.emit(event, data)),
  subscribe: (dotted) =>
    attempt(() => {
      const id = nextId++;
      events.set(id, []);
      const { owner, fn } = member(dotted);
      const off = fn.call(owner, (...args) => events.get(id).push(args));
      subs.set(id, off);
      return id;
    }),
  events: (id) => events.get(id) || [],
  unsubscribe: (id) =>
    attempt(() => {
      const off = subs.get(id);
      subs.delete(id);
      off();
      return true;
    }),
  advisor: (delayMs) =>
    attempt(() => {
      ctx.accounts.registerAdvisor({
        async rank(candidates, context) {
          if (delayMs) await sleep(delayMs);
          return {
            accounts: candidates.map((c) => ({ id: c.id, eligible: true, reason: 'from the extension' })),
            recommendedId: 'from-extension:' + context.purpose,
          };
        },
      });
      return true;
    }),
  onAction: (delayMs) =>
    attempt(() => {
      ctx.inbox.onAction(async (event) => {
        if (delayMs) await sleep(delayMs);
        return { resolve: 'approved', message: 'Handled ' + event.key + '.' };
      });
      return true;
    }),
  schedule: (seconds) =>
    attempt(() => {
      ctx.schedule(seconds, async () => {
        ctx.emit('tick', { at: Date.now() });
      });
      return true;
    }),
  toolsHandle: () => attempt(() => ctx.tools.handle('anything', async () => 1)),
  // A hostile payload built here (so only its structured-clone form crosses):
  // small on the channel, huge once expanded.
  hostileSave: (kind, id) => {
    let data;
    if (kind === 'sparse') {
      data = [];
      data.length = 9e7;
    } else {
      data = new Array(16000).fill({ t: 'x'.repeat(1.5e6) });
    }
    return module.exports.probes.raw({ type: 'call', id, path: 'storage.saveData', args: [data] });
  },
  // A hostile extension: a raw message straight onto the channel, around the
  // proxy. Only meaningful in a child (in-process there is no channel).
  raw: (message) =>
    new Promise((resolve) => {
      const onMessage = (m) => {
        if (m && m.type === 'ret' && m.id === message.id) {
          process.off('message', onMessage);
          clearTimeout(timer);
          resolve({ answered: true, ok: m.ok, error: m.error || null, value: m.value });
        }
      };
      const timer = setTimeout(() => {
        process.off('message', onMessage);
        resolve({ answered: false });
      }, 2000);
      process.on('message', onMessage);
      process.send(message);
    }),
};
`;
