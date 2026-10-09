import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { parseBrowserBinding } from '@dorkos/browser/server-owner';
import { inspectOriginalManagedVMSession } from '../runtime/managed-vm-acquisition.mjs';
const originals = new WeakMap(),
  same = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
const failure = (code) => new Error(code),
  MAX = 2097152,
  CHUNK = 64512;
export function inspectOriginalVMTransfer(owner, record) {
  const cell = originals.get(owner);
  if (!cell || cell.record !== record) throw failure('VM_ORIGINAL_TRANSFER_REQUIRED');
  return cell;
}
/** Captures genuine host lease/sink and actual private VM session. None of these
 * originals or their authority are represented by guest JSON. */
function base(record, binding, current) {
  const session = record.originalSession();
  inspectOriginalManagedVMSession(session, record.receiver);
  let first,
    closed = false,
    closing,
    cleanupJoined = false,
    guestAdmission;
  const jobs = new Set(),
    transfer = randomBytes(24).toString('hex');
  const check = (signal) => {
    if (first) throw first.value;
    signal?.throwIfAborted();
    if (closed || !current()) throw failure('VM_TRANSFER_RETIRED');
    record.exactTab(binding);
  };
  const own = (enter) => {
    if (closed) throw failure('VM_TRANSFER_RETIRED');
    const job = Promise.resolve().then(enter);
    jobs.add(job);
    void job.then(
      () => jobs.delete(job),
      (value) => {
        first ??= { value };
        jobs.delete(job);
      }
    );
    return job;
  };
  const close = (extra = []) =>
    (closing ??= (async () => {
      closed = true;
      let cleanupFirst;
      // closeTransfer cancels the retained local selection before entering its
      // normal single-bank wire request; original entered IO remains joined.
      const duties = [
        ...(guestAdmission ? [() => session.closeOriginalTransfer(guestAdmission)] : []),
        ...extra,
      ].map((fn) =>
        Promise.resolve()
          .then(fn)
          .catch((value) => {
            first ??= { value };
            throw value;
          })
      );
      const rows = await Promise.allSettled(duties);
      for (const row of rows) if (row.status === 'rejected') cleanupFirst ??= { value: row.reason };
      while (jobs.size) await Promise.allSettled([...jobs]);
      cleanupJoined = !cleanupFirst;
      if (first) throw first.value;
      if (cleanupFirst) throw cleanupFirst.value;
    })());
  return {
    record,
    binding,
    session,
    transfer,
    onAdmitted(token) {
      if (guestAdmission) throw failure('VM_TRANSFER_ADMISSION_REPLAY');
      guestAdmission = token;
    },
    check,
    own,
    close,
    jobs,
    cleanupJoined: () => cleanupJoined,
  };
}
export function createOriginalVMUpload(record, lease, current) {
  const binding = Object.freeze(parseBrowserBinding(lease.binding)),
    consume = lease.consume.bind(lease),
    enter = lease.enter.bind(lease),
    closeLease = lease.close.bind(lease),
    cell = base(record, binding, current);
  let begin,
    completion,
    bytes,
    armed = false,
    closing,
    releaseRecord;
  const owner = Object.freeze({
    begin(signal) {
      if (begin) return begin;
      begin = cell.own(async () => {
        cell.check(signal);
        const payload = await consume(signal);
        cell.check(signal);
        if (
          typeof payload.path !== 'string' ||
          !Number.isSafeInteger(payload.byteLength) ||
          payload.byteLength < 1 ||
          payload.byteLength > MAX
        )
          throw failure('VM_UPLOAD_PAYLOAD');
        const fd = await open(payload.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let first;
        try {
          cell.check(signal);
          const st = await fd.stat();
          cell.check(signal);
          if (!st.isFile() || st.size !== payload.byteLength)
            throw failure('VM_UPLOAD_ORIGINAL_FILE');
          bytes = Buffer.alloc(payload.byteLength);
          let offset = 0;
          while (offset < bytes.length) {
            cell.check(signal);
            const result = await fd.read(
              bytes,
              offset,
              Math.min(CHUNK, bytes.length - offset),
              offset
            );
            cell.check(signal);
            if (!result.bytesRead) throw failure('VM_UPLOAD_TRUNCATED');
            offset += result.bytesRead;
          }
          const final = await fd.stat();
          cell.check(signal);
          if (
            final.dev !== st.dev ||
            final.ino !== st.ino ||
            final.size !== st.size ||
            final.mtimeMs !== st.mtimeMs ||
            final.ctimeMs !== st.ctimeMs
          )
            throw failure('VM_UPLOAD_CHANGED');
        } catch (value) {
          first = { value };
        }
        try {
          await fd.close();
        } catch (value) {
          first ??= { value };
        }
        if (first) throw first.value;
        cell.check(signal);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await cell.session.uploadStage(
          binding.tabId,
          cell.transfer,
          bytes.length,
          sha256,
          cell.onAdmitted
        );
        cell.check(signal);
        let sequence = 0;
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          cell.check(signal);
          await cell.session.uploadChunk(
            binding.tabId,
            cell.transfer,
            ++sequence,
            bytes.subarray(offset, offset + CHUNK)
          );
          cell.check(signal);
        }
        bytes.fill(0);
        bytes = undefined;
        await cell.session.uploadSeal(binding.tabId, cell.transfer);
        cell.check(signal);
        await cell.session.uploadArm(binding.tabId, cell.transfer);
        cell.check(signal);
        armed = true;
      });
      return begin;
    },
    complete(value, signal) {
      if (completion) throw failure('VM_UPLOAD_REPLAY');
      completion = cell.own(async () => {
        cell.check(signal);
        if (!same(parseBrowserBinding(value), binding) || !begin)
          throw failure('VM_UPLOAD_BINDING');
        await begin;
        cell.check(signal);
        if (!armed) throw failure('VM_UPLOAD_UNARMED');
        await cell.session.transferSelection(binding.tabId, cell.transfer);
        cell.check(signal);
        await enter(async () => {
          cell.check(signal);
          await cell.session.uploadComplete(binding.tabId, cell.transfer);
          cell.check(signal);
        });
        cell.check(signal);
      });
      return completion;
    },
    close() {
      return (closing ??= cell.close([() => closeLease()]).finally(() => {
        bytes?.fill(0);
        bytes = undefined;
        if (cell.cleanupJoined()) releaseRecord?.();
      }));
    },
  });
  originals.set(owner, cell);
  releaseRecord = record.retainOriginalTransfer(owner);
  return owner;
}
export function createOriginalVMDownload(record, sink, current) {
  const binding = Object.freeze(parseBrowserBinding(sink.binding)),
    authorize = sink.authorize.bind(sink),
    stage = sink.stage.bind(sink),
    cell = base(record, binding, current);
  let begin, completion, result, closing, releaseRecord;
  const chunks = [];
  const permission = async (signal) => {
    cell.check(signal);
    await authorize(binding, signal);
    cell.check(signal);
  };
  const owner = Object.freeze({
    begin(signal) {
      if (begin) return begin;
      return (begin = cell.own(async () => {
        await permission(signal);
        await cell.session.downloadArm(binding.tabId, cell.transfer, cell.onAdmitted);
        cell.check(signal);
      }));
    },
    complete(value, signal) {
      if (completion) throw failure('VM_DOWNLOAD_REPLAY');
      return (completion = cell.own(async () => {
        cell.check(signal);
        if (!same(parseBrowserBinding(value), binding) || !begin)
          throw failure('VM_DOWNLOAD_BINDING');
        await begin;
        await permission(signal);
        const selected = await cell.session.transferSelection(binding.tabId, cell.transfer);
        cell.check(signal);
        const keys = Object.keys(selected).sort().join(',');
        if (
          !['mimeType,name', 'expectedBytes,mimeType,name'].includes(keys) ||
          typeof selected.name !== 'string' ||
          !selected.name ||
          selected.name.length > 100 ||
          !/^[A-Za-z0-9_-][A-Za-z0-9._ -]*$/.test(selected.name) ||
          !['text/plain', 'application/pdf', 'image/png', 'image/jpeg'].includes(
            selected.mimeType
          ) ||
          (Object.hasOwn(selected, 'expectedBytes') &&
            (!Number.isSafeInteger(selected.expectedBytes) ||
              selected.expectedBytes < 1 ||
              selected.expectedBytes > MAX))
        )
          throw failure('VM_DOWNLOAD_SELECTION');
        const hash = createHash('sha256');
        let sequence = 0,
          total = 0;
        while (true) {
          if (sequence >= 64) throw failure('VM_DOWNLOAD_READ_BANK');
          await permission(signal);
          const part = await cell.session.downloadNext(binding.tabId, cell.transfer);
          try {
            cell.check(signal);
            if (
              !(part.bytes instanceof Uint8Array) ||
              part.bytes.byteLength > CHUNK ||
              part.sequence !== sequence + 1 ||
              part.total !== total + part.bytes.byteLength ||
              typeof part.end !== 'boolean' ||
              (part.bytes.byteLength === 0 && !part.end) ||
              part.total > MAX
            )
              throw failure('VM_DOWNLOAD_BYTES');
            sequence++;
            total = part.total;
            const copy = Buffer.from(part.bytes);
            chunks.push(copy);
            hash.update(copy);
            if (part.end) {
              if (
                !total ||
                (selected.expectedBytes !== undefined && selected.expectedBytes !== total) ||
                typeof part.sha256 !== 'string' ||
                hash.digest('hex') !== part.sha256
              )
                throw failure('VM_DOWNLOAD_INTEGRITY');
              break;
            }
          } finally {
            if (part.bytes instanceof Uint8Array) part.bytes.fill(0);
          }
        }
        await permission(signal);
        const bytes = Buffer.concat(chunks, total);
        try {
          result = await stage(selected.name, selected.mimeType, bytes, signal);
          cell.check(signal);
        } finally {
          bytes.fill(0);
          for (const bytes of chunks) bytes.fill(0);
          chunks.length = 0;
        }
      }));
    },
    artifact() {
      if (!result) throw failure('VM_DOWNLOAD_ARTIFACT_UNAVAILABLE');
      return result;
    },
    close() {
      return (closing ??= cell.close().finally(() => {
        for (const bytes of chunks) bytes.fill(0);
        chunks.length = 0;
        if (cell.cleanupJoined()) releaseRecord?.();
      }));
    },
  });
  originals.set(owner, cell);
  releaseRecord = record.retainOriginalTransfer(owner);
  return owner;
}
