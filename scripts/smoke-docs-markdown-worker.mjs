#!/usr/bin/env node
/**
 * Prove a built markdown worker runs (DOR-2984): start it as the server does,
 * turn markdown into a Yjs document and back, and exit.
 *
 * The CLI and desktop builds run this on the `docs-markdown-worker.mjs` they
 * just bundled, so a worker that cannot load Blintz in Node (a missing
 * dependency, a DOM global, a bad banner) fails the build, not a person's
 * first live doc.
 *
 * Usage: node scripts/smoke-docs-markdown-worker.mjs <worker.mjs>
 */
import { Worker } from 'node:worker_threads';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/smoke-docs-markdown-worker.mjs <worker.mjs>');
  process.exit(2);
}

const worker = new Worker(file);
const timer = setTimeout(() => fail('the worker did not answer within 30 s'), 30_000);

function fail(reason) {
  console.error(`[smoke] markdown worker ${file}: ${reason}`);
  process.exit(1);
}

let step = 0;
worker.on('error', (error) => fail(error.stack ?? String(error)));
worker.on('message', (response) => {
  if (!response.ok) fail(`${response.code}: ${response.message}`);
  if (step === 0) {
    step = 1;
    worker.postMessage({ id: 2, op: 'serialize', state: response.state });
    return;
  }
  if (!response.markdown.includes('Hello from the build')) {
    fail(`round trip lost the text: ${JSON.stringify(response.markdown)}`);
  }
  clearTimeout(timer);
  console.log('  ✓ markdown worker round-trips a doc');
  // The headless model keeps timers alive for a few seconds; nothing is left to wait for.
  void worker.terminate().then(() => process.exit(0));
});
worker.postMessage({ id: 1, op: 'seed', markdown: '# Smoke\n\nHello from the build.\n' });
