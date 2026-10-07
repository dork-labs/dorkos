/** Sanitized temporary writer effect evidence; never a production grant/ledger. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rename, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanvasChannelEventReceiptSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';

const MAX_LEDGER = 8 * 1024 * 1024;
const MAX_NOTE = 64 * 1024;
const MAX_RECORD = 128 * 1024;
const MAX_CHANNEL_CAPTURE = 32 * 1024; // Fixture resource bound; NOT a promised protocol maximum.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type WriteRequest =
  | { operationId: string; kind: 'comment'; text: string }
  | { operationId: string; kind: 'toggle'; checked: boolean }
  | { operationId: string; kind: 'undo'; originalOperationId: string };
export interface WriterReceipt {
  operationId: string;
  requestHash: string;
  beforeHash: string;
  afterHash: string;
  file: 'notes/task.md';
  savedAt: string;
  mutationOrdinal: number;
}
export interface WriterOperation {
  request: WriteRequest;
  requestHash: string;
  envelopeHash: string;
  beforeHash: string;
  afterHash: string;
  after: string;
  createdAt: number;
  phase: 'intent' | 'saved' | 'in_doubt';
  writerReceipt?: WriterReceipt;
  handoff: 'pending' | 'sending' | 'recorded' | 'in_doubt';
  event: {
    v: 1;
    id: string;
    type: 'task.comment' | 'task.toggle';
    payload: Record<string, string | boolean>;
    coalesceKey?: string;
  };
  channelReceipt?: CanvasChannelEventReceipt;
}
interface Ledger {
  v: 1;
  owner: string;
  lastHash: string;
  mutations: number;
  health: 'ready' | 'in_doubt';
  operations: Record<string, WriterOperation>;
}
export type FaultStage = 'intent-durable' | 'file-replaced' | 'receipt-durable';
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
/** Encode closed writer request DATA with deterministic object key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(
    typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'Plain canonical request required'
  );
  return (
    '{' +
    Object.keys(value as object)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]))
      .join(',') +
    '}'
  );
}
/** Compute the hexadecimal SHA-256 digest of canonical writer DATA. */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function request(raw: unknown): WriteRequest {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'Writer request required');
  const row = raw as Record<string, unknown>;
  need(typeof row.operationId === 'string' && UUID.test(row.operationId), 'Stable UUID required');
  const keys =
    row.kind === 'comment'
      ? ['kind', 'operationId', 'text']
      : row.kind === 'toggle'
        ? ['kind', 'operationId', 'checked']
        : ['kind', 'operationId', 'originalOperationId'];
  need(
    Object.keys(row).length === keys.length && Object.keys(row).every((key) => keys.includes(key)),
    'Closed writer request required'
  );
  if (row.kind === 'comment')
    need(
      typeof row.text === 'string' && row.text.trim() && Buffer.byteLength(row.text) <= 8192,
      'Bounded nonempty comment'
    );
  else if (row.kind === 'toggle') need(typeof row.checked === 'boolean', 'Checkbox value required');
  else
    need(
      row.kind === 'undo' &&
        typeof row.originalOperationId === 'string' &&
        UUID.test(row.originalOperationId),
      'Original Undo UUID required'
    );
  return JSON.parse(JSON.stringify(row)) as WriteRequest;
}
async function atomic(path: string, bytes: string, replaced?: () => void): Promise<void> {
  const part = path + '.' + randomUUID() + '.tmp';
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let failed = false;
  let first: unknown;
  try {
    handle = await open(part, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(part, path);
    replaced?.();
    const directory = await open(join(path, '..'), 'r');
    let directoryFailed = false;
    let directoryCause: unknown;
    try {
      await directory.sync();
    } catch (cause) {
      directoryFailed = true;
      directoryCause = cause;
    }
    try {
      await directory.close();
    } catch (cause) {
      if (!directoryFailed) {
        directoryFailed = true;
        directoryCause = cause;
      }
    }
    if (directoryFailed) throw directoryCause;
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    if (handle)
      try {
        await handle.close();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    try {
      await rm(part, { force: true });
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first; // Explicit flag preserves even throw undefined over cleanup failure.
}

/** Root path cannot be supplied by caller: only this factory creates and retains it. */
export async function createConsumerVault(now = () => Date.now(), temporaryParent = tmpdir()) {
  const parent = await realpath(temporaryParent);
  const root = await mkdtemp(join(parent, 'dorkos-consumer-'));
  try {
    const owner = randomUUID();
    await mkdir(join(root, 'notes'));
    const initial = '# Sanitized tasks\n\n- [ ] Fixture task\n';
    await atomic(join(root, 'notes/task.md'), initial);
    let ledger: Ledger = {
      v: 1,
      owner,
      lastHash: digest(initial),
      mutations: 0,
      health: 'ready',
      operations: {},
    };
    await atomic(join(root, 'writer.json'), canonical(ledger));
    let tail: Promise<unknown> = Promise.resolve();
    let closed = false;
    let physicalReplacements = 0;
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      need(!closed, 'Temporary vault closed');
      const next = tail.then(fn);
      tail = next.catch(() => {});
      return next;
    };
    async function confined() {
      need(
        (await realpath(root)) === root && !(await lstat(root)).isSymbolicLink(),
        'Temporary root substituted'
      );
      for (const name of ['notes', 'notes/task.md', 'writer.json'])
        need(!(await lstat(join(root, name))).isSymbolicLink(), 'Temporary subject substituted');
    }
    async function flush() {
      const encoded = canonical(ledger);
      need(Buffer.byteLength(encoded) <= MAX_LEDGER, 'Ledger resource cap');
      try {
        await atomic(join(root, 'writer.json'), encoded);
      } catch (cause) {
        ledger.health = 'in_doubt';
        for (const op of Object.values(ledger.operations)) op.phase = 'in_doubt';
        throw cause;
      }
    }
    async function finalize(op: WriterOperation) {
      op.phase = 'saved';
      op.handoff = 'pending';
      ledger.mutations++;
      op.writerReceipt = {
        operationId: op.request.operationId,
        requestHash: op.requestHash,
        beforeHash: op.beforeHash,
        afterHash: op.afterHash,
        file: 'notes/task.md',
        savedAt: new Date(now()).toISOString(),
        mutationOrdinal: ledger.mutations,
      };
      ledger.lastHash = op.afterHash;
      await flush();
    }
    async function inspect() {
      await confined();
      const note = await readFile(join(root, 'notes/task.md'), 'utf8');
      need(Buffer.byteLength(note) <= MAX_NOTE, 'Note resource cap');
      return {
        markdown: note,
        ledger: structuredClone(ledger),
        producerCounters: { physicalReplacements },
      };
    }
    return {
      root,
      write(raw: unknown, fault?: (stage: FaultStage) => void) {
        return serial(async () => {
          await confined();
          const req = request(raw);
          const hash = digest(canonical(req));
          const prior = ledger.operations[req.operationId];
          if (prior) {
            need(prior.requestHash === hash, 'OPERATION_ID_CONFLICT');
            need(prior.writerReceipt && prior.phase === 'saved', 'WRITER_EFFECT_IN_DOUBT');
            const persisted = JSON.parse(
              await readFile(join(root, 'writer.json'), 'utf8')
            ) as Ledger;
            const saved = persisted.operations[req.operationId];
            need(
              saved?.writerReceipt && saved.phase === 'saved' && saved.requestHash === hash,
              'WRITER_DURABILITY_UNCONFIRMED'
            );
            return structuredClone(saved);
          }
          need(ledger.health === 'ready', 'WRITER_RECOVERY_REQUIRED');
          const before = await readFile(join(root, 'notes/task.md'), 'utf8');
          need(digest(before) === ledger.lastHash, 'EXTERNAL_RESTORE_OR_EDIT');
          let after: string;
          let checked = false;
          if (req.kind === 'comment')
            after = before + '\n<!-- operation:' + req.operationId + ' -->\n' + req.text + '\n';
          else {
            if (req.kind === 'toggle') checked = req.checked;
            else {
              const original = ledger.operations[req.originalOperationId];
              need(
                original?.request.kind === 'toggle' &&
                  original.writerReceipt &&
                  now() - original.createdAt <= 300000,
                'UNDO_EXPIRED_OR_UNAVAILABLE'
              );
              need(original.afterHash === digest(before), 'UNDO_BASELINE_CHANGED');
              checked = !original.request.checked;
            }
            need(/^- \[[ x]\] Fixture task$/m.test(before), 'Fixture checkbox missing');
            after = before.replace(
              /^- \[[ x]\] Fixture task$/m,
              '- [' + (checked ? 'x' : ' ') + '] Fixture task'
            );
            need(after !== before, 'NO_FILE_MUTATION');
          }
          need(Buffer.byteLength(after) <= MAX_NOTE, 'Note resource cap');
          const event: WriterOperation['event'] = {
            v: 1,
            id: req.operationId,
            type: req.kind === 'comment' ? 'task.comment' : 'task.toggle',
            payload:
              req.kind === 'comment'
                ? { text: req.text, writerRequestHash: hash }
                : { checked, writerRequestHash: hash },
            ...(req.kind === 'comment' ? {} : { coalesceKey: 'fixture-task' }),
          };
          const op: WriterOperation = {
            request: req,
            requestHash: hash,
            envelopeHash: digest(canonical(event)),
            beforeHash: digest(before),
            afterHash: digest(after),
            after,
            createdAt: now(),
            phase: 'intent',
            handoff: 'pending',
            event,
          };
          need(Object.keys(ledger.operations).length < 128, 'Operation count cap');
          // Reserve maximum final record/handoff growth BEFORE stage or effect. No grant from this bound.
          need(
            Buffer.byteLength(canonical(op)) + MAX_CHANNEL_CAPTURE + 2048 <= MAX_RECORD,
            'Completion reservation cannot fit'
          );
          need(
            (Object.keys(ledger.operations).length + 1) * MAX_RECORD + 8192 <= MAX_LEDGER,
            'Outstanding completion reservations exhausted'
          );
          ledger.operations[req.operationId] = op;
          await flush();
          fault?.('intent-durable');
          await atomic(join(root, 'notes/task.md'), after, () => {
            physicalReplacements++;
          });
          fault?.('file-replaced');
          await finalize(op);
          fault?.('receipt-durable');
          return structuredClone(op); // Durable distinct writer receipt AND pending handoff precede successful response.
        });
      },
      snapshot: () => serial(inspect),
      pending: () =>
        serial(async () =>
          Object.values(ledger.operations)
            .filter(
              (op) =>
                ledger.health === 'ready' &&
                op.phase === 'saved' &&
                op.writerReceipt &&
                op.handoff === 'pending'
            )
            .map((op) => structuredClone(op))
        ),
      beginHandoff(id: string) {
        return serial(async () => {
          const op = ledger.operations[id];
          need(
            ledger.health === 'ready' &&
              op?.phase === 'saved' &&
              op.writerReceipt &&
              op.handoff === 'pending',
            'HANDOFF_NOT_PRE_ADMISSION'
          );
          op.handoff = 'sending';
          await flush();
          return structuredClone(op);
        });
      },
      recordChannel(id: string, raw: unknown) {
        return serial(async () => {
          const op = ledger.operations[id];
          need(
            op?.writerReceipt && ['sending', 'in_doubt', 'recorded'].includes(op.handoff),
            'NO_WRITER_HANDOFF'
          );
          // A fixture capture bound is not an invented genuine protocol receipt maximum.
          need(
            Buffer.byteLength(JSON.stringify(raw)) <= MAX_CHANNEL_CAPTURE,
            'CHANNEL_RECEIPT_CAPTURE_HELD'
          );
          const receipt = CanvasChannelEventReceiptSchema.parse(raw);
          need(
            receipt.receipt.id === id && receipt.receipt.docSeq > 0,
            'CHANNEL_RECEIPT_ID_MISMATCH'
          );
          if (op.channelReceipt)
            need(
              op.channelReceipt.receipt.docSeq === receipt.receipt.docSeq,
              'CHANNEL_RECEIPT_CONFLICT'
            );
          need(
            Buffer.byteLength(canonical({ ...op, channelReceipt: receipt, handoff: 'recorded' })) <=
              MAX_RECORD,
            'COMPLETION_CAPTURE_HELD'
          );
          op.channelReceipt = receipt;
          op.handoff = 'recorded';
          await flush();
          return structuredClone(op);
        });
      },
      async reopen() {
        return serial(async () => {
          await confined();
          const bytes = await readFile(join(root, 'writer.json'), 'utf8');
          need(Buffer.byteLength(bytes) <= MAX_LEDGER, 'Ledger resource cap');
          const next = JSON.parse(bytes) as Ledger;
          need(
            next.v === 1 &&
              next.owner === owner &&
              Number.isSafeInteger(next.mutations) &&
              next.mutations >= ledger.mutations &&
              typeof next.operations === 'object',
            'Temporary writer identity or continuity changed'
          );
          for (const [id, op] of Object.entries(next.operations)) {
            need(
              UUID.test(id) &&
                request(op.request).operationId === id &&
                op.requestHash === digest(canonical(op.request)) &&
                op.envelopeHash === digest(canonical(op.event)) &&
                op.event.id === id &&
                op.afterHash === digest(op.after) &&
                Buffer.byteLength(canonical(op)) <= MAX_RECORD,
              'Writer owned record corrupted'
            );
            if (op.channelReceipt) {
              const checked = CanvasChannelEventReceiptSchema.parse(op.channelReceipt);
              need(checked.receipt.id === id, 'Channel capture corrupted');
            }
          }
          ledger = next;
          const physical = digest(await readFile(join(root, 'notes/task.md'), 'utf8'));
          const intents = Object.values(ledger.operations).filter((op) => op.phase === 'intent');
          if (intents.length === 1 && intents[0]!.afterHash === physical)
            await finalize(intents[0]!);
          else if (intents.length || physical !== ledger.lastHash) {
            ledger.health = 'in_doubt';
            for (const op of intents) op.phase = 'in_doubt';
          }
          for (const op of Object.values(ledger.operations))
            if (op.handoff === 'sending') op.handoff = 'in_doubt';
          await flush();
          return inspect();
        });
      },
      noteOpen: () =>
        serial(async () => ({ file: 'notes/task.md' as const, ...(await inspect()) })),
      inspectUndoPair: (a: string, b: string) =>
        serial(async () => {
          await confined();
          const persisted = JSON.parse(await readFile(join(root, 'writer.json'), 'utf8')) as Ledger;
          need(
            persisted.owner === owner && persisted.health === 'ready' && ledger.health === 'ready',
            'ORIGINAL_WRITER_UNAVAILABLE'
          );
          const first = persisted.operations[a],
            second = persisted.operations[b];
          need(
            a !== b &&
              first?.phase === 'saved' &&
              second?.phase === 'saved' &&
              first.writerReceipt &&
              second.writerReceipt &&
              first.channelReceipt &&
              second.channelReceipt &&
              first.request.kind === 'toggle' &&
              second.request.kind === 'undo' &&
              second.request.originalOperationId === a,
            'BOTH_DURABLE_RECEIPTS_REQUIRED'
          );
          need(
            canonical(first) === canonical(ledger.operations[a]) &&
              canonical(second) === canonical(ledger.operations[b]),
            'ORIGINAL_LEDGER_CHANGED'
          );
          need(
            first.requestHash === digest(canonical(first.request)) &&
              second.requestHash === digest(canonical(second.request)),
            'ORIGINAL_REQUEST_CHANGED'
          );
          for (const operation of [first, second])
            need(
              operation.writerReceipt!.operationId === operation.request.operationId &&
                operation.writerReceipt!.requestHash === operation.requestHash &&
                operation.writerReceipt!.beforeHash === operation.beforeHash &&
                operation.writerReceipt!.afterHash === operation.afterHash &&
                operation.writerReceipt!.file === 'notes/task.md' &&
                operation.envelopeHash === digest(canonical(operation.event)),
              'ORIGINAL_EFFECT_RECEIPT_CHANGED'
            );
          const firstChannel = CanvasChannelEventReceiptSchema.parse(first.channelReceipt),
            secondChannel = CanvasChannelEventReceiptSchema.parse(second.channelReceipt);
          need(
            firstChannel.receipt.id === a &&
              secondChannel.receipt.id === b &&
              firstChannel.receipt.docSeq > 0 &&
              secondChannel.receipt.docSeq > firstChannel.receipt.docSeq,
            'ORIGINAL_CHANNEL_ORDER_CHANGED'
          );
          const currentPhysicalHash = digest((await inspect()).markdown);
          need(
            first.beforeHash === second.afterHash && currentPhysicalHash === second.afterHash,
            'BASELINE_CHANGED'
          );
          // Test-owned physical effect evidence only. The original native owner must
          // independently inspect its current generation/batch/claim/FIRST state;
          // these records cannot grant permission or cancel a native operation.
          return Object.freeze({
            writerOwner: owner,
            subject: 'notes/task.md' as const,
            operationIds: Object.freeze([a, b] as const),
            baselineHash: first.beforeHash,
            currentPhysicalHash,
            writerReceipts: Object.freeze([
              structuredClone(first.writerReceipt),
              structuredClone(second.writerReceipt),
            ]),
            channelReceipts: Object.freeze([firstChannel, secondChannel]),
            envelopeHashes: Object.freeze([first.envelopeHash, second.envelopeHash]),
          });
        }),
      auditAck(event: unknown) {
        return serial(async () => {
          const bytes = canonical(event);
          need(Buffer.byteLength(bytes) <= 16384, 'Audit mirror cap');
          const auditPath = join(root, 'ack-audit.jsonl');
          try {
            const info = await lstat(auditPath);
            need(
              !info.isSymbolicLink() &&
                info.isFile() &&
                info.size + Buffer.byteLength(bytes) + 1 <= MAX_LEDGER,
              'Audit mirror resource cap'
            );
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
          }
          const file = await open(auditPath, 'a', 0o600);
          let failed = false;
          let first: unknown;
          try {
            await file.write(bytes + '\n');
            await file.sync();
          } catch (cause) {
            failed = true;
            first = cause;
          }
          try {
            await file.close();
          } catch (cause) {
            if (!failed) {
              failed = true;
              first = cause;
            }
          }
          if (failed) throw first;
          // Audit mirror never updates receipts, dispatches, resends or settles app authority.
        });
      },
      async close() {
        closed = true;
        await tail;
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {}
    throw cause;
  }
}
export type ConsumerVault = Awaited<ReturnType<typeof createConsumerVault>>;
