import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { semanticCommand, decodeSemanticChunk, isSemanticAction } from './guest/semantic-wire.mjs';
const observations = new WeakMap(),
  bad = (code) => new Error(code);
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
/** Original serial origin/correlation only. A guest result never supplies host
 * actor, grant, SemanticIdentity, lease or edit authorization. */
export function inspectOriginalSemanticObservation(token, session, tabId, action) {
  const row = observations.get(token);
  if (!row || row.session !== session || row.tabId !== tabId || row.action !== action)
    throw bad('VM_ORIGINAL_SEMANTIC_OBSERVATION_REQUIRED');
  return row.value;
}
export function createOriginalSemanticProtocol({ guard, request, originalSession }) {
  const clear = (pending) => {
    pending.semantic?.bytes.fill(0);
    pending.semantic = undefined;
  };
  return Object.freeze({
    request(action, tabId, fields = {}) {
      const value = semanticCommand({ request: 1, action, tabId, ...fields });
      const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'request'));
      return request(body);
    },
    frame(pending, original) {
      if (!isSemanticAction(pending.action)) return false;
      const cell = pending.semantic;
      if (!cell || cell.complete) throw bad('VM_UNREQUESTED_SEMANTIC_FRAME');
      const row = decodeSemanticChunk(original);
      try {
        guard();
        if (
          row.metadata.request !== pending.request ||
          row.metadata.tabId !== pending.tabId ||
          row.metadata.sequence !== cell.chunks ||
          cell.chunks >= cell.expectedChunks ||
          cell.offset + row.bytes.length > cell.bytes.length
        )
          throw bad('VM_SEMANTIC_CHUNK_CORRELATION');
        // Every nonfinal body is the fixed full chunk; no alternate partitioning
        // can grow the number of admitted delivery callbacks.
        const expected = Math.min(61440, cell.bytes.length - cell.offset);
        if (row.bytes.length !== expected) throw bad('VM_SEMANTIC_CHUNK_LENGTH');
        cell.bytes.set(row.bytes, cell.offset);
        cell.offset += row.bytes.length;
        cell.chunks++;
        return true;
      } finally {
        row.bytes.fill(0);
      }
    },
    consume(pending, value) {
      if (!isSemanticAction(pending.action)) return { handled: false };
      guard();
      if (value.request !== pending.request || value.tabId !== pending.tabId)
        throw bad('VM_SEMANTIC_REPLY_CORRELATION');
      if (value.event === 'semantic-result-begin') {
        if (
          !exact(value, 'event,request,tabId,action,bytes,chunks,sha256') ||
          value.action !== pending.action ||
          pending.action === 'semantic-close' ||
          pending.semantic ||
          !Number.isSafeInteger(value.bytes) ||
          value.bytes < 1 ||
          value.bytes > 262144 ||
          value.chunks !== Math.ceil(value.bytes / 61440) ||
          typeof value.sha256 !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.sha256)
        )
          throw bad('VM_SEMANTIC_BEGIN');
        pending.semantic = {
          bytes: Buffer.alloc(value.bytes),
          offset: 0,
          chunks: 0,
          expectedChunks: value.chunks,
          sha256: value.sha256,
          complete: false,
        };
        return { handled: true };
      }
      if (value.event === 'semantic-result-end') {
        const cell = pending.semantic;
        if (
          !exact(value, 'event,request,tabId,sha256') ||
          !cell ||
          cell.complete ||
          cell.offset !== cell.bytes.length ||
          cell.chunks !== cell.expectedChunks ||
          value.sha256 !== cell.sha256 ||
          createHash('sha256').update(cell.bytes).digest('hex') !== cell.sha256
        )
          throw bad('VM_SEMANTIC_END');
        cell.complete = true;
        return { handled: true };
      }
      if (value.event === 'semantic-closed') {
        if (
          pending.action !== 'semantic-close' ||
          !exact(value, 'event,request,tabId') ||
          pending.semantic
        )
          throw bad('VM_SEMANTIC_CLOSE');
        return { handled: true, settled: true };
      }
      if (value.event === 'semantic-completed') {
        const cell = pending.semantic;
        if (
          !exact(value, 'event,request,tabId,action') ||
          value.action !== pending.action ||
          !cell?.complete
        )
          throw bad('VM_SEMANTIC_COMPLETION');
        let parsed;
        try {
          parsed = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(cell.bytes));
        } finally {
          clear(pending);
        }
        guard();
        const token = Object.freeze(Object.create(null));
        observations.set(
          token,
          Object.freeze({
            session: originalSession(),
            tabId: pending.tabId,
            action: pending.action,
            value: parsed,
          })
        );
        return { handled: true, settled: true, value: token };
      }
      return { handled: false };
    },
    refuse(pending, value, mint) {
      if (value.event !== 'semantic-refused') return false;
      if (
        !isSemanticAction(pending.action) ||
        !exact(value, 'event,request,tabId,action,reason') ||
        value.request !== pending.request ||
        value.tabId !== pending.tabId ||
        value.action !== pending.action ||
        !['document-changed', 'unavailable'].includes(value.reason) ||
        (pending.semantic && !pending.semantic.complete)
      )
        throw bad('VM_SEMANTIC_REFUSAL');
      clear(pending);
      guard();
      pending.reject(mint(value.reason));
      return true;
    },
    clear,
  });
}
