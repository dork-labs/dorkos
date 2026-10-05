/** Caller rollback must never erase acceptance after an external delivery effect. */
import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { createDb, runMigrations } from '@dorkos/db';
import { isProcessAlive, processStartTime } from '@dorkos/shared/process-liveness';

const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const dbModule = new URL('../../../db/src/index.ts', import.meta.url).href;
const coreModule = new URL('../relay-core.ts', import.meta.url).href;
const livenessModule = new URL('../../../shared/src/process-liveness.ts', import.meta.url).href;
interface Snapshot {
  adapters: string[];
  subscribers: string[];
  receipts: unknown[];
  index: unknown[];
  sentinel: unknown[];
  owners: unknown[];
  files: string[];
}
interface Report {
  kind: string;
  pid: number;
  birth?: string | null;
  node?: string;
  abi?: string;
  before?: Snapshot;
  duringUnrelated?: Snapshot;
  after?: Snapshot;
  publishCode?: string;
  locator?: string;
  closeCode?: string;
  error?: string;
}
function message(child: ChildProcess): Promise<Report> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', receive);
      child.off('exit', exited);
      child.off('error', failed);
    };
    const receive = (value: unknown) => {
      cleanup();
      const report = value as Report;
      if (report.kind === 'fatal') reject(new Error(report.error));
      else resolve(report);
    };
    const exited = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before required IPC observation: ${code}`));
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once('message', receive);
    child.once('exit', exited);
    child.once('error', failed);
  });
}

/** Direct source imports, exact-owned IPC acknowledgements and raw SQL prevent a vacuous oracle. */
async function observe(transaction: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-rollback-oracle-'));
  const path = join(dir, 'db.sqlite');
  const db = createDb(path);
  runMigrations(db);
  db.$client.exec('CREATE TABLE rollback_sentinel (value TEXT NOT NULL)');
  db.$client.close();
  const source = `
    import {createDb} from ${JSON.stringify(dbModule)};
    import {RelayCore} from ${JSON.stringify(coreModule)};
    import {processStartTime} from ${JSON.stringify(livenessModule)};
    import {readdirSync,existsSync} from 'node:fs';
    import {join} from 'node:path';
    const send=value=>new Promise((resolve,reject)=>process.send(value,error=>error?reject(error):resolve()));
    const command=()=>new Promise(resolve=>process.once('message',resolve));
    const adapters=[],subscribers=[];let locator,publishCode,closeCode;
    const db=createDb(${JSON.stringify(path)}),dataDir=${JSON.stringify(join(dir, 'relay'))};
    const core=new RelayCore({db,dataDir,
      adapterRegistry:{setRelay(){},shutdown:async()=>{},deliver(subject,envelope){adapters.push(envelope.id);return Promise.resolve({success:true});}}});
    core.subscribe('relay.agent.rollback-oracle',envelope=>{subscribers.push(envelope.id);});
    const files=dir=>existsSync(dir)?readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]):[];
    const capture=()=>({adapters:[...adapters],subscribers:[...subscribers],
      receipts:db.$client.prepare('SELECT * FROM relay_delivery_receipts').all(),
      index:db.$client.prepare('SELECT * FROM relay_index').all(),
      sentinel:db.$client.prepare('SELECT * FROM rollback_sentinel').all(),
      owners:db.$client.prepare('SELECT * FROM relay_receipt_observer_owner').all(),
      files:files(join(dataDir,'mailboxes'))});
    try {
      const run=command();
      await send({kind:'ready',pid:process.pid,birth:processStartTime(process.pid)?.toISOString()??null,node:process.version,abi:process.versions.modules});
      await run;
      if(${transaction}) {db.$client.exec('BEGIN');db.$client.prepare('INSERT INTO rollback_sentinel VALUES (?)').run('caller-work');}
      let before;
      try {await core.publish('relay.agent.rollback-oracle','private-sentinel',
        {from:'local-client',receiptContext:{ownerUserId:null,onReceiptCreated(id){locator=id;}}});}
      catch(error){publishCode=error.code;}
      finally {before=capture();if(db.$client.inTransaction)db.$client.exec('ROLLBACK');}
      let duringUnrelated;
      if(!${transaction}) {
        db.$client.exec('BEGIN');
        try {db.$client.prepare('INSERT INTO rollback_sentinel VALUES (?)').run('unrelated-caller-work');duringUnrelated=capture();}
        finally {db.$client.exec('ROLLBACK');}
      }
      const after=capture();
      const acknowledged=command();await send({kind:'observed',pid:process.pid,before,duringUnrelated,after,publishCode,locator});await acknowledged;
      try {await core.close();}catch(error){closeCode=error.code;}
      if(db.$client.inTransaction)db.$client.exec('ROLLBACK');db.$client.close();
      const exit=command();await send({kind:'closed',pid:process.pid,closeCode});await exit;
      process.exit(0);
    }catch(error){await send({kind:'fatal',pid:process.pid,error:String(error)});process.exit(1);}
  `;
  let child: ChildProcess | undefined;
  let birth: Date | null = null;
  let stderr = '';
  let closure: Promise<unknown[]> | undefined;
  try {
    child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        TMPDIR: tmpdir(),
        LANG: 'C',
        TZ: 'UTC',
      },
    });
    child.stderr!.on('data', (value: Buffer) => {
      stderr += value.toString();
    });
    // Register both closure signals before any command; a packet cannot stand in for death.
    const exited = once(child, 'exit');
    const closed = (closure = once(child, 'close'));
    const ready = await message(child);
    expect(ready.kind).toBe('ready');
    expect(ready.node).toBe(process.version);
    expect(ready.abi).toBe(process.versions.modules);
    birth = ready.birth ? new Date(ready.birth) : null;
    expect(birth).not.toBeNull();
    const observations = message(child);
    child.send('run');
    const report = await observations;
    expect(report.kind).toBe('observed');
    const cleanup = message(child);
    child.send('observations-acknowledged');
    const closeReport = await cleanup;
    expect(closeReport.kind).toBe('closed');
    child.send('exit-authorized');
    expect(await exited).toEqual([0, null]);
    expect(await closed).toEqual([0, null]);
    expect(child.connected).toBe(false);
    expect(child.stdout!.destroyed).toBe(true);
    expect(child.stderr!.destroyed).toBe(true);
    expect(isProcessAlive(child.pid!)).toBe(false);
    expect(processStartTime(child.pid!)).toBeNull();
    expect(stderr).toBe('');
    process.stdout.write(
      JSON.stringify({
        oracle: 'caller-rollback',
        ...ready,
        ...report,
        closeCode: closeReport.closeCode,
        exit: 0,
        stdioClosed: true,
        birthAbsent: true,
      }) + '\n'
    );
    return { report, closeReport };
  } catch (error) {
    console.error('owned IPC fixture diagnostic', stderr);
    throw error;
  } finally {
    // Exceptional fixture cleanup targets only the exact child object with unchanged birth identity.
    if (child && child.exitCode === null && child.signalCode === null) {
      const actualBirth = processStartTime(child.pid!);
      if (birth && actualBirth?.getTime() === birth.getTime()) {
        const exit = once(child, 'exit');
        const close = once(child, 'close');
        child.kill();
        await exit;
        await close;
      }
    }
    await closure;
    rmSync(dir, { recursive: true, force: true });
  }
}

it('normal outside-transaction delivery actually reaches the matched external effect', async () => {
  const { report, closeReport } = await observe(false);
  expect(report.before!.adapters).toEqual([report.locator]);
  expect(report.before!.receipts).toEqual([
    expect.objectContaining({ message_id: report.locator, state: 'delivered' }),
  ]);
  expect(report.before!.owners).toHaveLength(1);
  expect(report.duringUnrelated!.sentinel).toEqual([{ value: 'unrelated-caller-work' }]);
  expect(report.duringUnrelated!.receipts).toEqual(report.before!.receipts);
  expect(report.duringUnrelated!.index).toEqual(report.before!.index);
  expect(report.duringUnrelated!.owners).toEqual(report.before!.owners);
  expect(report.after!.receipts).toEqual(report.before!.receipts);
  expect(report.after!.index).toEqual(report.before!.index);
  expect(report.after!.owners).toEqual(report.before!.owners);
  expect(report.after!.adapters).toEqual(report.before!.adapters);
  expect(report.after!.subscribers).toEqual(report.before!.subscribers);
  expect(report.after!.files).toEqual(report.before!.files);
  expect(report.after!.sentinel).toEqual([]);
  expect(closeReport.closeCode).toBeUndefined();
}, 30_000);

it('caller rollback has zero external effects even when unsafe transaction joining would erase acceptance', async () => {
  const { report, closeReport } = await observe(true);
  // PRIMARY oracle runs only after captured rows, real rollback and exact child/resource closure.
  expect(report.before!.adapters).toEqual([]);
  expect(report.before!.subscribers).toEqual([]);
  expect(report.before!.files).toEqual([]);
  expect(report.after!.adapters).toEqual([]);
  expect(report.after!.subscribers).toEqual([]);
  expect(report.after!.receipts).toEqual([]);
  expect(report.after!.index).toEqual([]);
  expect(report.after!.sentinel).toEqual([]);
  expect(report.before!.owners).toEqual([]);
  expect(report.after!.owners).toEqual([]);
  expect(report.after!.files).toEqual([]);
  expect(report.before!.sentinel).toEqual([{ value: 'caller-work' }]);
  expect(report.publishCode).toBe('RELAY_RECEIPT_TRANSACTION_ACTIVE');
  expect(report.locator).toBeUndefined();
  expect(closeReport.closeCode).toBeUndefined();
}, 30_000);
