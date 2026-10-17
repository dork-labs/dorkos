/**
 * The markdown worker: every markdown ↔ Yjs conversion live docs need, off the
 * server's event loop (DOR-2984).
 *
 * Runs in a `worker_threads` worker. It builds ONE headless Blintz model when
 * it starts and reuses it for every request (Blintz's contract: one model per
 * worker). It keeps no document between requests; each request carries the
 * state it works on (`worker-protocol.ts`).
 *
 * Shipped builds bundle this file on its own, beside the server bundle
 * (`worker-entry.ts` finds it), so it must import nothing from the rest of the
 * server.
 *
 * @module services/docs/collab/markdown-worker
 */
import { parentPort } from 'node:worker_threads';
import * as Y from 'yjs';
import * as blintzCollab from 'blintz/collab';
import type {
  MarkdownWorkerRequest,
  MarkdownWorkerResponse,
  MarkdownWorkerResult,
} from './worker-protocol.js';

/** Blintz's headless model; only ever handed back to Blintz. */
export type MarkdownModel = object;

/**
 * The three `blintz/collab` functions this worker calls, typed here because
 * Blintz 0.8.0's declarations import their siblings without file extensions,
 * which the server's NodeNext resolution cannot follow, so they read as `any`.
 * The shapes are Blintz's own (`collab/ydoc.ts`, `headless.ts`).
 */
interface BlintzCollab {
  createMarkdownModel(): Promise<MarkdownModel>;
  applyMarkdownToYDoc(
    model: MarkdownModel,
    doc: Y.Doc,
    markdown: string,
    options?: { base?: Uint8Array }
  ): { base: Uint8Array };
  yDocToMarkdown(model: MarkdownModel, doc: Y.Doc): string;
}

const { applyMarkdownToYDoc, createMarkdownModel, yDocToMarkdown } =
  blintzCollab as unknown as BlintzCollab;

/**
 * Build a markdown model the way the worker does, for code that answers
 * requests in-process (the worker itself, and tests that act as an editor).
 */
export function loadMarkdownModel(): Promise<MarkdownModel> {
  return createMarkdownModel();
}

/** A document holding `state`. */
function docFrom(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/**
 * Answer one request.
 *
 * @param model - The worker's one markdown model.
 * @param request - What to do.
 */
export function handleMarkdownRequest(
  model: MarkdownModel,
  request: MarkdownWorkerRequest
): MarkdownWorkerResult {
  switch (request.op) {
    case 'seed': {
      const doc = new Y.Doc();
      applyMarkdownToYDoc(model, doc, request.markdown);
      const state = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      return { op: 'seed', state };
    }
    case 'serialize': {
      const doc = docFrom(request.state);
      const markdown = yDocToMarkdown(model, doc);
      doc.destroy();
      return { op: 'serialize', markdown };
    }
    case 'merge': {
      const doc = docFrom(request.state);
      const before = Y.encodeStateVector(doc);
      const { base } = applyMarkdownToYDoc(model, doc, request.markdown, {
        ...(request.base ? { base: request.base } : {}),
      });
      const update = Y.encodeStateAsUpdate(doc, before);
      const markdown = yDocToMarkdown(model, doc);
      doc.destroy();
      return { op: 'merge', update, base, markdown };
    }
  }
}

/** Blintz names its `base` refusals; everything else is a plain failure. */
function failureOf(id: number, error: unknown): MarkdownWorkerResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { id, ok: false, code: message.includes('`base`') ? 'BASE_MISMATCH' : 'FAILED', message };
}

/** The buffers an answer carries, moved to the server rather than copied. */
function transferablesOf(result: MarkdownWorkerResult): ArrayBuffer[] {
  const buffers =
    result.op === 'seed'
      ? [result.state]
      : result.op === 'merge'
        ? [result.update, result.base]
        : [];
  return buffers.map((bytes) => bytes.buffer as ArrayBuffer);
}

if (parentPort) {
  const port = parentPort;
  const model = loadMarkdownModel();
  port.on('message', (request: MarkdownWorkerRequest) => {
    model.then(
      (ready) => {
        let response: MarkdownWorkerResponse;
        let transfer: ArrayBuffer[] = [];
        try {
          const result = handleMarkdownRequest(ready, request);
          response = { id: request.id, ok: true, ...result };
          transfer = transferablesOf(result);
        } catch (error) {
          response = failureOf(request.id, error);
        }
        port.postMessage(response, transfer);
      },
      (error: unknown) => port.postMessage(failureOf(request.id, error))
    );
  });
}
