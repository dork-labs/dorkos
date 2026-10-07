import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createSemanticProcess } from '../process-owner.js';
const raw = vi.hoisted(() => ({
  pending: new Set<Promise<void>>(),
  overflow: undefined as (() => void) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const child = actual.spawn(...args);
      let diagnosticBytes = 0;
      child.stderr!.on('data', (bytes: Buffer) => {
        diagnosticBytes += bytes.length;
        if (diagnosticBytes > 262144) raw.overflow?.();
      });
      const returned = Promise.allSettled(
        [child, child.stdout!, child.stderr!, child.stdio[3]!].map(
          (source) => new Promise<void>((resolve) => source.once('close', () => resolve()))
        )
      ).then(() => {});
      raw.pending.add(returned);
      void returned.then(() => raw.pending.delete(returned));
      return child;
    },
  };
});
const finalizers: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(finalizers.splice(0).map((close) => close()));
  await Promise.allSettled([...raw.pending]);
  raw.overflow = undefined;
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
// Actual owned Node children/protocol originals; no browser/native/positive authority doubles.
it.each(['early-zero', 'original-stderr-overflow'] as const)(
  'joins child and every original pipe on %s without leaving initialization pending',
  async (mode) => {
    const bank: {
      starting?: Promise<Awaited<ReturnType<typeof createSemanticProcess>>>;
      expected?: { reason: unknown };
    } = {};
    let root: string | undefined,
      owner: Awaited<ReturnType<typeof createSemanticProcess>> | undefined;
    let closed = false,
      closing: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const server = createServer((_req, res) => {
      contacts++;
      res.end();
    });
    let contacts = 0;
    const finish = (): Promise<void> => {
      closed = true;
      return (closing ??= Promise.resolve().then(async () => {
        let first: { reason: unknown } | undefined;
        await Promise.allSettled([...pending]);
        try {
          if (bank.starting) owner = await bank.starting;
          await owner?.close();
        } catch (reason) {
          if (!bank.expected || !Object.is(bank.expected.reason, reason)) first = { reason };
        }
        await Promise.allSettled([...raw.pending]);
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        if (root)
          try {
            await rm(root, { recursive: true, force: true });
          } catch (reason) {
            first ??= { reason };
          }
        if (first) throw first.reason;
      }));
    };
    finalizers.push(finish);
    const acquiring = mkdtemp(join(tmpdir(), 'semantic-original-process-')).then((value) => {
      root = value;
      return value;
    });
    pending.add(acquiring);
    const directory = await acquiring;
    pending.delete(acquiring);
    if (closed) throw new Error('FIXTURE_CLOSED');
    const path = join(directory, 'original-negative-worker.mjs');
    const writing = writeFile(
      path,
      mode === 'early-zero'
        ? 'process.exit(0);'
        : `
      import {Socket} from 'node:net';
      const pipe=new Socket({fd:3,readable:true,writable:true,allowHalfOpen:true});
      let bytes=Buffer.alloc(0);
      const send=value=>{const body=Buffer.from(JSON.stringify(value));const header=Buffer.alloc(4);header.writeUInt32BE(body.length);pipe.write(Buffer.concat([header,body]));};
      pipe.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=4+bytes.readUInt32BE(0)){const size=bytes.readUInt32BE(0);const value=JSON.parse(bytes.subarray(4,4+size));bytes=bytes.subarray(4+size);if(value.kind==='initialize'){send({kind:'ready'});process.stderr.write(Buffer.alloc(262145,120));}else if(value.kind==='close'){send({kind:'closed',ok:true});pipe.end();}}});
    `
    );
    pending.add(writing);
    await writing;
    pending.delete(writing);
    if (closed) throw new Error('FIXTURE_CLOSED');
    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    pending.add(listening);
    await listening;
    pending.delete(listening);
    if (closed) throw new Error('FIXTURE_CLOSED');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
    const overflow = new Promise<void>((resolve) => {
      raw.overflow = resolve;
    });
    bank.starting = createSemanticProcess(
      'ws://127.0.0.1:' + address.port + '/devtools/browser/original-owned',
      'original-target',
      path
    );
    void bank.starting.catch(() => {});
    let observed: { reason: unknown } | undefined;
    try {
      owner = await bank.starting;
      if (mode === 'original-stderr-overflow') await overflow;
      await owner.close();
    } catch (reason) {
      observed = { reason };
    }
    expect(observed?.reason).toBeInstanceOf(Error);
    bank.expected = observed;
    expect((observed!.reason as Error).message).toBe(
      mode === 'early-zero' ? 'SEMANTIC_WORKER_TERMINAL' : 'SEMANTIC_DIAGNOSTIC_EXCEEDED'
    );
    expect(raw.pending.size).toBe(0);
    expect(contacts).toBe(0);
    expect(server.listening).toBe(true);
  }
);
