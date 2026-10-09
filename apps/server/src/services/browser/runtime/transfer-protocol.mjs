import { createHash } from 'node:crypto';
import { decodeTransferChunk, encodeTransferChunk } from './guest/transfer-wire.mjs';
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = (v) => typeof v === 'string' && /^[a-f0-9]{48}$/.test(v);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const error = (code) => new Error(code);
/** Constructor-private original session exchange. Facts are correlated here;
 * genuine lease/sink/Work admission stays in the host transfer owners. */
export function createOriginalTransferProtocol({ guard, request, cancelRequest, joinRequests }) {
  const cells = new Map(),
    closedCells = new Map(),
    seen = new Set(),
    admissions = new WeakMap();
  let stopped = false,
    closeTail = Promise.resolve();
  const get = (tabId, transfer) => {
    const cell = cells.get(transfer);
    if (!cell || cell.tabId !== tabId) throw error('VM_TRANSFER_CORRELATION');
    return cell;
  };
  const create = (tabId, transfer, kind, onAdmitted) => {
    guard();
    if (
      stopped ||
      !id(transfer) ||
      seen.has(transfer) ||
      seen.size >= 64 ||
      cells.size >= 2 ||
      [...cells.values()].some((row) => row.tabId === tabId)
    )
      throw error('VM_TRANSFER_BANK');
    let yes, no;
    const selected = new Promise((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    void selected.catch(() => {});
    const cell = {
      tabId,
      transfer,
      kind,
      selected,
      yes,
      no,
      reads: 0,
      total: 0,
      hash: kind === 'download' ? createHash('sha256') : null,
      done: false,
      armRequest: null,
      choice: null,
      closing: false,
      closeCause: error('VM_ORIGINAL_TRANSFER_SELECTION_CLOSED'),
    };
    cells.set(transfer, cell);
    seen.add(transfer);
    const token = Object.freeze(Object.create(null));
    admissions.set(token, { tabId, transfer });
    onAdmitted?.(token);
    return cell;
  };
  const operation = (cell, action, extra = {}, bytes) => {
    guard();
    if (cell.refusal) throw cell.refusal;
    if (stopped || cell.closing) throw error('VM_TRANSFER_CLOSED');
    return request(
      { action, tabId: cell.tabId, transfer: cell.transfer, ...extra },
      bytes,
      (number) => {
        if (action === 'upload-arm' || action === 'download-arm') cell.armRequest = number;
      }
    );
  };
  const protocol = Object.freeze({
    refused(value, pending, makeStale) {
      if (value?.event !== 'transfer-refused') return false;
      guard();
      const cell = get(value.tabId, value.transfer);
      if (
        !exact(value, 'event,request,tabId,transfer,reason') ||
        !['document-changed', 'navigation-superseded'].includes(value.reason) ||
        !(
          value.request === cell.armRequest ||
          (pending?.transfer === cell.transfer && pending?.request === value.request)
        )
      )
        throw error('VM_TRANSFER_REFUSAL_CORRELATION');
      const cause = (cell.refusal ??= makeStale());
      cell.guestClosed = true;
      cell.no(cause);
      if (pending?.transfer === cell.transfer && pending.request === value.request) {
        pending.transferChunk?.bytes.fill(0);
        pending.reject(cause);
        return 'pending';
      }
      return true;
    },
    selected(value) {
      if (value?.event !== 'transfer-selected') return false;
      guard();
      const cell = get(value.tabId, value.transfer);
      const keys =
        cell.kind === 'upload'
          ? 'event,request,tabId,transfer'
          : Object.hasOwn(value, 'expectedBytes')
            ? 'event,request,tabId,transfer,name,mimeType,expectedBytes'
            : 'event,request,tabId,transfer,name,mimeType';
      if (!exact(value, keys) || value.request !== cell.armRequest || cell.choice)
        throw error('VM_TRANSFER_SELECTION_CORRELATION');
      if (
        cell.kind === 'download' &&
        (typeof value.name !== 'string' ||
          value.name.length < 1 ||
          value.name.length > 100 ||
          !/^[-A-Za-z0-9._ ]+$/.test(value.name) ||
          /[. ]$/.test(value.name) ||
          /^[. ]/.test(value.name) ||
          !['text/plain', 'application/pdf', 'image/png', 'image/jpeg'].includes(value.mimeType) ||
          (Object.hasOwn(value, 'expectedBytes') &&
            (!Number.isSafeInteger(value.expectedBytes) ||
              value.expectedBytes < 0 ||
              value.expectedBytes > 2097152)))
      )
        throw error('VM_TRANSFER_SELECTION_METADATA');
      cell.choice = Object.freeze(
        cell.kind === 'download'
          ? {
              name: value.name,
              mimeType: value.mimeType,
              ...(Object.hasOwn(value, 'expectedBytes')
                ? { expectedBytes: value.expectedBytes }
                : {}),
            }
          : {}
      );
      if (!cell.closing) cell.yes(cell.choice);
      return true;
    },
    frame(pending, bytes) {
      if (pending.action !== 'download-next') return false;
      const row = decodeTransferChunk('download-chunk', bytes);
      if (
        row.metadata.request !== pending.request ||
        row.metadata.tabId !== pending.tabId ||
        row.metadata.transfer !== pending.transfer ||
        pending.transferChunk
      ) {
        row.bytes.fill(0);
        throw error('VM_TRANSFER_CHUNK_CORRELATION');
      }
      pending.transferChunk = row;
      return true;
    },
    reply(pending, value) {
      if (!pending.transfer) return { handled: false };
      const cell = get(pending.tabId, pending.transfer);
      const events = {
        'upload-stage': 'transfer-ready',
        'upload-seal': 'transfer-sealed',
        'upload-arm': 'transfer-armed',
        'upload-complete': 'transfer-completed',
        'download-arm': 'transfer-armed',
        'transfer-close': 'transfer-closed',
        'upload-chunk': 'transfer-written',
        'download-next': 'transfer-progress',
      };
      if (
        value.event !== events[pending.action] ||
        value.request !== pending.request ||
        value.tabId !== pending.tabId ||
        value.transfer !== pending.transfer
      )
        throw error('VM_TRANSFER_REPLY_CORRELATION');
      if (pending.action === 'upload-chunk') {
        if (
          !exact(value, 'event,request,tabId,transfer,sequence') ||
          value.sequence !== pending.transferSequence
        )
          throw error('VM_TRANSFER_WRITE_CORRELATION');
        return { handled: true };
      }
      if (pending.action === 'download-next') {
        const keys = value.end
          ? 'event,request,tabId,transfer,sequence,total,end,sha256'
          : 'event,request,tabId,transfer,sequence,total,end';
        const chunk = pending.transferChunk;
        if (
          !exact(value, keys) ||
          typeof value.end !== 'boolean' ||
          !Number.isSafeInteger(value.sequence) ||
          value.sequence < 1 ||
          !Number.isSafeInteger(value.total) ||
          value.total < 1 ||
          value.total > 2097152 ||
          (value.end && !sha(value.sha256)) ||
          !chunk ||
          chunk.metadata.sequence !== value.sequence ||
          (!value.end && !chunk.bytes.length)
        )
          throw error('VM_TRANSFER_READ_CORRELATION');
        if (
          cell.done ||
          cell.reads >= 64 ||
          value.sequence !== cell.reads + 1 ||
          value.total !== cell.total + chunk.bytes.length
        )
          throw error('VM_TRANSFER_READ_SEQUENCE');
        cell.hash.update(chunk.bytes);
        cell.reads++;
        cell.total = value.total;
        if (value.end) {
          cell.done = true;
          if (cell.hash.digest('hex') !== value.sha256) throw error('VM_TRANSFER_BODY_HASH');
        }
        return {
          handled: true,
          value: Object.freeze({
            bytes: chunk.bytes,
            sequence: value.sequence,
            total: value.total,
            end: value.end,
            ...(value.end ? { sha256: value.sha256 } : {}),
          }),
        };
      }
      if (!exact(value, 'event,request,tabId,transfer')) throw error('VM_TRANSFER_REPLY_FIELDS');
      return { handled: true };
    },
    uploadStage(tabId, transfer, byteLength, digest, onAdmitted) {
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength < 1 ||
        byteLength > 2097152 ||
        !sha(digest)
      )
        throw error('VM_TRANSFER_UPLOAD_BYTES');
      const cell = create(tabId, transfer, 'upload', onAdmitted);
      return operation(cell, 'upload-stage', { byteLength, sha256: digest });
    },
    uploadChunk(tabId, transfer, sequence, bytes) {
      const cell = get(tabId, transfer);
      if (cell.kind !== 'upload') throw error('VM_TRANSFER_KIND');
      return operation(cell, 'upload-chunk', { sequence }, bytes);
    },
    uploadSeal(tabId, transfer) {
      return operation(get(tabId, transfer), 'upload-seal');
    },
    uploadArm(tabId, transfer) {
      return operation(get(tabId, transfer), 'upload-arm');
    },
    uploadComplete(tabId, transfer) {
      const cell = get(tabId, transfer);
      if (cell.refusal) throw cell.refusal;
      if (!cell.choice) throw error('VM_TRANSFER_UNSELECTED');
      return operation(cell, 'upload-complete');
    },
    downloadArm(tabId, transfer, onAdmitted) {
      return operation(create(tabId, transfer, 'download', onAdmitted), 'download-arm');
    },
    selection(tabId, transfer) {
      guard();
      const cell = get(tabId, transfer);
      if (cell.refusal) throw cell.refusal;
      return cell.selected;
    },
    downloadNext(tabId, transfer) {
      const cell = get(tabId, transfer);
      if (cell.refusal) throw cell.refusal;
      if (cell.kind !== 'download' || !cell.choice || cell.done || cell.reads >= 64)
        throw error('VM_TRANSFER_UNSELECTED');
      return operation(cell, 'download-next');
    },
    closeOriginalTransfer(token) {
      const row = admissions.get(token);
      if (!row) throw error('VM_ORIGINAL_TRANSFER_ADMISSION_REQUIRED');
      return protocol.closeTransfer(row.tabId, row.transfer);
    },
    closeTransfer(tabId, transfer) {
      const cell = cells.get(transfer);
      if (!cell) {
        const previous = closedCells.get(transfer);
        if (!previous || previous.tabId !== tabId) throw error('VM_TRANSFER_CORRELATION');
        return previous.close;
      }
      if (cell.tabId !== tabId) throw error('VM_TRANSFER_CORRELATION');
      if (cell.close) return cell.close;
      cell.closing = true;
      cell.no(cell.closeCause);
      const body = { action: 'transfer-close', tabId, transfer };
      let cancellation, first;
      // Exact active-read cancellation enters before any queued unrelated close.
      // Otherwise that close could be waiting for the very read we must cancel.
      if (!cell.guestClosed)
        try {
          cancellation = cancelRequest?.(body);
        } catch (value) {
          first = { value };
        }
      const finish = async (ordinary) => {
        const attempt = async (job) => {
          try {
            return await job();
          } catch (value) {
            first ??= { value };
          }
        };
        if (cancellation) await attempt(() => cancellation);
        if (ordinary) {
          await attempt(joinRequests);
          if (!first && !cell.guestClosed) await attempt(() => request(body));
        }
        // Early close ACK/background refusal cannot retire correlation while an
        // admitted read/frame/native-write callback still owns it.
        await attempt(joinRequests);
        if (first) throw first.value;
        closedCells.set(transfer, Object.freeze({ tabId: cell.tabId, close: cell.close }));
        cells.delete(transfer);
      };
      if (cancellation || first || cell.guestClosed) cell.close = finish(false);
      else {
        cell.close = closeTail.then(() => finish(true));
        closeTail = cell.close.catch(() => {});
      }
      return cell.close;
    },
    stop(cause) {
      stopped = true;
      for (const cell of cells.values()) cell.no(cause);
    },
    encode(number, body, bytes) {
      return encodeTransferChunk(
        'upload-chunk',
        { request: number, tabId: body.tabId, transfer: body.transfer, sequence: body.sequence },
        bytes
      );
    },
  });
  return protocol;
}
