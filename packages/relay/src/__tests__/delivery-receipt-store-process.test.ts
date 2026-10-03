/** Real child-process arbitration: SQLite owns the lease, IPC owns the test ordering. */
import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createDb, runMigrations } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import { vi } from 'vitest';

const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const dbModule = new URL('../../../db/src/index.ts', import.meta.url).href;
const coreModule = new URL('../relay-core.ts', import.meta.url).href;

interface Report {
  kind: string;
  pid?: number;
  id?: string;
  code?: string;
  effects?: number;
}

/** Every waiter rejects on startup failure or exit; no polling, sleeps or inferred readiness. */
function nextMessage(child: ChildProcess): Promise<Report> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', error);
    };
    const message = (value: unknown) => {
      cleanup();
      resolve(value as Report);
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before IPC report: ${code}`));
    };
    const error = (err: Error) => {
      cleanup();
      reject(err);
    };
    child.once('message', message);
    child.once('exit', exit);
    child.once('error', error);
  });
}

it('allows exactly one real process to create acceptance; dead-owner takeover recovers without replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-process-'));
  const path = join(dir, 'db.sqlite');
  const db = createDb(path);
  runMigrations(db);
  const children: ChildProcess[] = [];
  let successorCore: RelayCore | undefined;
  let stderr = '';
  // Each real Core shares the file DB but has its own Maildir. Fake only the deferred adapter effect.
  const source = `
    import {createDb} from ${JSON.stringify(dbModule)};
    import {RelayCore} from ${JSON.stringify(coreModule)};
    const db=createDb(${JSON.stringify(path)});let effects=0;
    const core=new RelayCore({db,dataDir:${JSON.stringify(dir)}+'/child-'+process.pid,
      adapterRegistry:{setRelay(){},shutdown:async()=>{},deliver(){effects++;return new Promise(()=>{});}}});
    process.on('message',async command=>{
      if(command==='acquire') {
        try {const result=await core.publish('relay.agent.example','payload',
          {from:'local-client',receiptContext:{ownerUserId:null,onReceiptCreated(){}}});
          process.send({kind:'winner',pid:process.pid,id:result.messageId,effects});
        } catch(error) {process.send({kind:'loser',code:error.code,effects});}
      }
      // Intentionally omit Core.close to prove actual abandoned-owner recovery.
      if(command==='exit') {db.$client.close();process.exit(0);}
    });
    process.send({kind:'ready'});
  `;
  try {
    const ready = Array.from({ length: 2 }, () => {
      const child = spawn(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', source],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
      );
      children.push(child);
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      return nextMessage(child);
    });
    expect(await Promise.all(ready)).toEqual([{ kind: 'ready' }, { kind: 'ready' }]);
    const reports = children.map((child) => nextMessage(child));
    children.forEach((child) => child.send('acquire'));
    const results = await Promise.all(reports);
    expect(results.map((result) => result.kind).sort()).toEqual(['loser', 'winner']);
    const winnerIndex = results.findIndex((result) => result.kind === 'winner');
    expect(results[winnerIndex]).toEqual({
      kind: 'winner',
      pid: children[winnerIndex].pid,
      id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
      effects: 1,
    });
    expect(results[1 - winnerIndex]).toEqual({
      kind: 'loser',
      code: 'RELAY_RECEIPT_OBSERVER_BUSY',
      effects: 0,
    });
    const successorEffect = vi.fn(async () => null);
    const successor = (successorCore = new RelayCore({
      db,
      dataDir: join(dir, 'successor'),
      adapterRegistry: { deliver: successorEffect, setRelay() {}, shutdown: async () => {} },
    }));
    expect(() =>
      successor.getDeliveryReceipt(results[winnerIndex].id!, { loginEnabled: false })
    ).toThrow(expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' }));
    const exit = once(children[winnerIndex], 'exit');
    children[winnerIndex].send('exit');
    expect(await exit).toEqual([0, null]);
    expect(
      successor.getDeliveryReceipt(results[winnerIndex].id!, { loginEnabled: false })
    ).toMatchObject({
      messageId: results[winnerIndex].id,
      state: 'outcome_unknown',
      failure: { code: 'observation_lost' },
    });
    expect(db.$client.prepare('SELECT count(*) FROM relay_delivery_receipts').pluck().get()).toBe(
      1
    );
    expect(successorEffect).not.toHaveBeenCalled();
    await successor.close();
    expect(stderr).toBe('');
  } finally {
    // Stop only these test-owned children, and wait for actual process death before removing files.
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, 'exit');
          child.kill();
          await exit;
        }
      })
    );
    await successorCore?.close();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
