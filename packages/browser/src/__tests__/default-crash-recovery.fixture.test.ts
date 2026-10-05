import {
  mkdtemp,
  realpath,
  chmod,
  rm,
  readFile,
  mkdir,
  copyFile,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  observeJournalDirectory,
  readJournal,
  type JournalSnapshot,
  type JournalLocation,
} from '../lifecycle/process-journal.js';
import { startDarwinJournalWorker, darwinMonotonicNow } from '../runtime/darwin-journal-worker.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { createDarwinProcessObserver, darwinBirth } from '../runtime/darwin-process-observer.js';
// Explicit private native fixture arm; absent in ordinary package tests.
// eslint-disable-next-line no-restricted-syntax
const helper = process.env.DORKOS_DARWIN_OBSERVER_FIXTURE;
// eslint-disable-next-line no-restricted-syntax
const workerPath = process.env.DORKOS_DARWIN_JOURNAL_WORKER_FIXTURE;
it.skipIf(!helper || process.platform !== 'darwin')(
  'queries a genuine live owner and a naturally exited owned child',
  async () => {
    const observer = createDarwinProcessObserver({
      path: helper!,
      sha256: createHash('sha256')
        .update(await readFile(helper!))
        .digest('hex'),
    });
    const current = await observer.inspect([process.pid]);
    const fact = current.processes[0];
    expect(fact.kind).toBe('present');
    if (fact.kind !== 'present') throw new Error('missing fixture owner');
    expect(fact.zombie).toBe(false);
    expect(darwinBirth(fact.identity).pid).toBe(process.pid);
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},200)'], { stdio: 'ignore' });
    const terminal = once(child, 'close');
    await once(child, 'spawn');
    const pid = child.pid!;
    const live = await observer.inspect([pid]);
    expect(live.processes[0].kind).toBe('present');
    await terminal;
    const gone = await observer.inspect([pid]);
    expect(gone.processes[0]).toEqual({ kind: 'absent', pid });
  },
  10000
);

it
  .skipIf(!helper || !workerPath || process.platform !== 'darwin')
  .each(['natural', 'crash', 'owned-crash'] as const)(
  'separate supervisor retains a genuine root across %s manager loss until original disappearance',
  async (mode) => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'darwin-journal-fixture-')));
    await chmod(parent, 0o700);
    const digest = createHash('sha256')
      .update(await readFile(helper!))
      .digest('hex');
    const observer = createDarwinProcessObserver({ path: helper!, sha256: digest });
    const rootScript = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},2400)'],{stdio:'ignore'});c.unref();setTimeout(()=>{},1800);`;
    const managerChild = spawn(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');const end=setTimeout(()=>process.disconnect(),5000);process.once('message',()=>{clearTimeout(end);const c=spawn(process.execPath,['-e',${JSON.stringify(rootScript)}],{stdio:'ignore'});c.unref();process.send({pid:c.pid});setTimeout(()=>process.disconnect(),${mode === 'natural' ? 900 : 3000});});`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    );
    const terminal = once(managerChild, 'close');
    try {
      await once(managerChild, 'spawn');
      const native = await observer.inspect([managerChild.pid!]);
      const managerFact = native.processes[0];
      if (managerFact.kind !== 'present') throw new Error('fixture manager enrollment missing');
      const manager = darwinBirth(managerFact.identity);
      const time = darwinMonotonicNow();
      const window = {
        startSequence: 0,
        checkpointSequence: 0,
        endSequence: 0,
        startMonotonic: time,
        endMonotonic: time,
      };
      const binding = {
        journalId: 'journal_native_fixture',
        browserId: 'browser_native_fixture',
        profile: { kind: 'ephemeral' as const },
        browserGeneration: 0,
        reservationNonce: 'native_fixture_nonce',
        runtimeIdentityDigest: 'a'.repeat(64),
        manager,
        bootScope: {
          kind: 'observed' as const,
          value: `darwin-boot:${native.bootSeconds}:${native.bootMicroseconds}`,
          sourceIdentityDigest: digest,
        },
      };
      let location: JournalLocation = {
        parentDirectory: parent,
        parentIdentity: await observeJournalDirectory(parent),
        binding,
      };
      const initial: JournalSnapshot = {
        schemaVersion: 1,
        kind: 'browser-process-journal',
        provenance: 'recorded-data',
        binding,
        writer: { writerId: 'native_fixture_observer', epoch: 0, kind: 'observer' },
        sequence: 0,
        phase: 'allocated',
        observationWindow: window,
        root: { kind: 'pending' },
        retainedIdentities: [
          {
            identity: manager,
            role: 'manager',
            parent: null,
            association: null,
            currentParent: null,
            acquisitionEpoch: 0,
            firstSeenSequence: 0,
            lastSeenSequence: 0,
            relationWindow: window,
            lifecycle: 'alive',
          },
        ],
        gaps: [],
        firstCause: null,
      };
      const supervisor = await startDarwinJournalWorker({
        workerPath: workerPath!,
        location,
        initial,
        artifact: { path: helper!, sha256: digest },
        duration: 6000,
        maxGap: 1000,
        ownedLaunch: mode === 'owned-crash',
      });
      expect(supervisor.child.pid).not.toBe(manager.pid);
      if (mode === 'owned-crash') {
        location = supervisor.location;
        await supervisor.launchRoot({
          executable: process.execPath,
          argv: ['-e', rootScript],
          cwd: parent,
        });
      } else {
        const launched = once(managerChild, 'message');
        managerChild.send({ kind: 'launch' });
        const [message] = await launched;
        const rootBatch = await observer.inspect([(message as { pid: number }).pid]);
        const rootFact = rootBatch.processes[0];
        if (rootFact.kind !== 'present') throw new Error('fixture root enrollment missing');
        await supervisor.enrollRoot(darwinBirth(rootFact.identity));
      }
      if (mode !== 'natural') {
        let enrolled = await readJournal(location);
        for (let attempt = 0; attempt < 40; attempt++) {
          if (
            enrolled.state === 'valid-recorded-data' &&
            enrolled.snapshot.retainedIdentities.some((value) => value.role === 'descendant')
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
          enrolled = await readJournal(location);
        }
        expect(enrolled.state).toBe('valid-recorded-data');
        if (enrolled.state === 'valid-recorded-data') {
          expect(
            enrolled.snapshot.retainedIdentities.some((value) => value.role === 'descendant')
          ).toBe(true);
          expect(enrolled.snapshot.gaps).toEqual([]);
        }
        // Exact fixture-owned original manager; supervisor and Chromium are never signaled.
        expect(managerChild.kill('SIGKILL')).toBe(true);
      }
      await terminal;
      let checkpoint = await readJournal(location);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (
          checkpoint.state === 'valid-recorded-data' &&
          checkpoint.snapshot.phase === 'manager-lost'
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
        checkpoint = await readJournal(location);
      }
      expect(checkpoint.state).toBe('valid-recorded-data');
      if (checkpoint.state === 'valid-recorded-data') {
        expect(checkpoint.snapshot.phase).toBe('manager-lost');
        expect(
          checkpoint.snapshot.retainedIdentities.find((value) => value.role === 'root')?.lifecycle
        ).toBe('alive');
      }
      const result = await supervisor.completion;
      const read = await readJournal(location);
      const diagnosticRaw = new TextDecoder().decode(supervisor.stderr());
      console.info(
        JSON.stringify({
          kind: 'native-foundation-observation',
          mode,
          result,
          nativeRefusal: diagnosticRaw || null,
        })
      );
      expect(read.state).toBe('valid-recorded-data');
      if (read.state === 'valid-recorded-data') {
        if (result === 'retained') {
          // A real incomplete native snapshot permanently withholds authority, even after
          // the already-enrolled originals have naturally returned. No generic refusal pass.
          expect(mode).not.toBe('owned-crash');
          const diagnostic = JSON.parse(diagnosticRaw);
          expect(diagnostic.kind).toBe('incomplete-native-children');
          expect(diagnostic.batch.complete).toBe(false);
          expect(diagnostic.batch.bootSeconds).toBe(native.bootSeconds);
          expect(diagnostic.batch.bootMicroseconds).toBe(native.bootMicroseconds);
          expect(read.snapshot.firstCause?.cause).toBe('association-missing');
          expect(read.snapshot.gaps[0].identity).toEqual(diagnostic.parent);
          expect(read.snapshot.gaps.every((gap) => gap.cause === 'association-missing')).toBe(true);
          expect(read.snapshot.phase).toBe('retained');
        } else {
          expect(result, JSON.stringify({ journal: read, nativeRefusal: diagnosticRaw })).toBe(
            mode === 'owned-crash' ? 'original-child-returned-observer-live' : 'recorded-gone'
          );
          expect(read.snapshot.phase).toBe('observation-ended');
          expect(read.snapshot.gaps).toEqual([]);
        }
        expect(read.snapshot.root.kind).toBe('attributed');
        expect(read.snapshot.retainedIdentities.map((value) => value.lifecycle)).toEqual([
          mode === 'owned-crash' ? 'alive' : 'dead',
          'dead',
          'dead',
        ]);
        expect(read.snapshot.retainedIdentities[2]!.role).toBe('descendant');
        const returned = read.snapshot.retainedIdentities.filter(
          (value) => !(mode === 'owned-crash' && value.role === 'manager')
        );
        const actual = await observer.inspect(returned.map((value) => value.identity.pid));
        expect(actual.bootSeconds).toBe(native.bootSeconds);
        expect(actual.bootMicroseconds).toBe(native.bootMicroseconds);
        expect(actual.processes.map((value) => value.kind)).toEqual(returned.map(() => 'absent'));
      }
    } finally {
      await terminal;
      await rm(parent, { recursive: true, force: true });
    }
  },
  10000
);

it.skipIf(!helper || !workerPath || process.platform !== 'darwin').each([false, true])(
  'ends an actual browser campaign with its manager alive (launch=%s)',
  async (launch) => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'darwin-normal-stop-')));
    const digest = createHash('sha256')
      .update(await readFile(helper!))
      .digest('hex');
    const observer = createDarwinProcessObserver({ path: helper!, sha256: digest });
    const native = await observer.inspect([process.pid]);
    const fact = native.processes[0];
    if (fact.kind !== 'present') throw new Error('manager unavailable');
    const manager = darwinBirth(fact.identity),
      time = darwinMonotonicNow();
    const window = {
      startSequence: 0,
      checkpointSequence: 0,
      endSequence: 0,
      startMonotonic: time,
      endMonotonic: time,
    };
    const binding = {
      journalId: 'normal-stop',
      browserId: 'browser',
      profile: { kind: 'ephemeral' as const },
      browserGeneration: 0,
      reservationNonce: 'nonce',
      runtimeIdentityDigest: 'a'.repeat(64),
      manager,
      bootScope: {
        kind: 'observed' as const,
        value: `darwin-boot:${native.bootSeconds}:${native.bootMicroseconds}`,
        sourceIdentityDigest: digest,
      },
    };
    const location = {
      parentDirectory: parent,
      parentIdentity: await observeJournalDirectory(parent),
      binding,
    };
    const initial: JournalSnapshot = {
      schemaVersion: 1,
      kind: 'browser-process-journal',
      provenance: 'recorded-data',
      binding,
      writer: { writerId: 'observer', epoch: 0, kind: 'observer' },
      sequence: 0,
      phase: 'allocated',
      observationWindow: window,
      root: { kind: 'pending' },
      retainedIdentities: [
        {
          identity: manager,
          role: 'manager',
          parent: null,
          association: null,
          currentParent: null,
          acquisitionEpoch: 0,
          firstSeenSequence: 0,
          lastSeenSequence: 0,
          relationWindow: window,
          lifecycle: 'alive',
        },
      ],
      gaps: [],
      firstCause: null,
    };
    const worker = await startDarwinJournalWorker({
      workerPath: workerPath!,
      location,
      initial,
      artifact: { path: helper!, sha256: digest },
      duration: 4000,
      maxGap: 1000,
    });
    let observing = launch;
    const traffic = (async () => {
      while (observing) {
        await observer.inspect([process.pid]);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    void traffic.catch(() => {});
    try {
      if (launch) {
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},500)'], {
          stdio: 'ignore',
        });
        const terminal = once(child, 'close');
        await once(child, 'spawn');
        const rootFact = (await observer.inspect([child.pid!])).processes[0];
        if (rootFact.kind !== 'present') throw new Error('root unavailable');
        await worker.enrollRoot(darwinBirth(rootFact.identity));
        await terminal;
      }
      await worker.endBrowser(launch);
      const outcome = await worker.completion;
      expect(outcome, JSON.stringify(await readJournal(location))).toBe('campaign-closed');
      const read = await readJournal(location);
      expect(read.state).toBe('valid-recorded-data');
      if (read.state === 'valid-recorded-data') {
        expect(read.snapshot.gaps).toEqual([]);
        expect(read.snapshot.root.kind).toBe(launch ? 'attributed' : 'absent-before-launch');
        expect(read.snapshot.retainedIdentities[0].lifecycle).toBe('alive');
      }
    } finally {
      observing = false;
      await traffic;
      await worker.completion;
      await rm(parent, { recursive: true, force: true });
    }
  },
  10000
);

it
  .skipIf(!helper || process.platform !== 'darwin')
  .each(['healthy', 'source-change', 'binary-change', 'extra-field'])(
  'loads the fixed packaged artifact and refuses %s corruption',
  async (mode) => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'darwin-packaged-fixture-')));
    const assets = join(parent, 'native');
    await mkdir(assets, { mode: 0o700 });
    try {
      for (const name of [
        'darwin-process-observer',
        'darwin-process-observer.c',
        'darwin-process-observer.h',
        'darwin-process-observer.manifest.json',
      ])
        await copyFile(join(dirname(helper!), name), join(assets, name));
      const module = join(parent, 'loader.mjs');
      await copyFile(
        join(dirname(dirname(helper!)), 'darwin-packaged-observer.fixture.mjs'),
        module
      );
      if (mode === 'source-change')
        await writeFile(join(assets, 'darwin-process-observer.c'), 'changed source');
      if (mode === 'binary-change')
        await writeFile(join(assets, 'darwin-process-observer'), 'changed binary');
      if (mode === 'extra-field') {
        const value = JSON.parse(
          await readFile(join(assets, 'darwin-process-observer.manifest.json'), 'utf8')
        );
        value.extra = true;
        await writeFile(
          join(assets, 'darwin-process-observer.manifest.json'),
          JSON.stringify(value)
        );
      }
      const loaded = await import(/* @vite-ignore */ pathToFileURL(module).href);
      if (mode === 'healthy') {
        const result = await loaded.loadPackagedDarwinJournal();
        expect(result.artifact.path).toBe(join(assets, 'darwin-process-observer'));
        expect(result.artifact.sha256).toBe(
          createHash('sha256')
            .update(await readFile(helper!))
            .digest('hex')
        );
        expect(result.workerPath).toBe(join(parent, 'darwin-journal-worker.js'));
      } else await expect(loaded.loadPackagedDarwinJournal()).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  10000
);

it.skipIf(!helper || process.platform !== 'darwin')(
  'uses actual native engine lifetimes for holder and original-process observations',
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'darwin-engine-identity-')));
    const processes = createDarwinEngineProcesses({
      path: helper!,
      sha256: createHash('sha256')
        .update(await readFile(helper!))
        .digest('hex'),
    });
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { stdio: 'ignore' });
    const terminal = once(child, 'close');
    try {
      await once(child, 'spawn');
      const identity = await processes.identity(child.pid!);
      const manager = await processes.identity(process.pid);
      expect(await processes.attributeRoot(manager!, identity!)).toBe(true);
      expect(await processes.attributeRoot(identity!, identity!)).toBe(false);
      expect(identity?.birth).toMatch(/^darwin-bsd-start:\d+:\d+$/);
      await symlink(`${hostname()}-${child.pid}`, join(directory, 'SingletonLock'));
      expect(await processes.holder(directory)).toEqual(identity);
      const signal = new AbortController().signal;
      expect(await processes.processes.observe(identity!, signal)).toEqual({ status: 'alive' });
      expect(
        await processes.processes.observe({ pid: child.pid!, birth: 'wrong-lifetime' }, signal)
      ).toEqual({ status: 'dead' });
      expect(await processes.processes.descendants(identity!, signal)).toEqual({
        status: 'complete',
        identities: [identity],
      });
      await terminal;
      expect(await processes.processes.observe(identity!, signal)).toEqual({ status: 'dead' });
      await expect(processes.holder(directory)).rejects.toThrow('UNKNOWN_NATIVE_HOLDER');
    } finally {
      await terminal;
      await rm(directory, { recursive: true, force: true });
    }
  },
  10000
);

it.skipIf(!helper || process.platform !== 'darwin')(
  'retains an actual asset close fault and refuses every later packaged admission',
  async () => {
    const script = `
const fs=require('node:fs/promises');const {syncBuiltinESMExports}=require('node:module');
const originalOpen=fs.open;let closes=[],opens=0;fs.open=async(...args)=>{opens++;const handle=await originalOpen(...args);closes.push(handle.close.bind(handle));handle.close=async()=>{throw new Error('ACTUAL_CLOSE_FAULT')};return handle};syncBuiltinESMExports();
(async()=>{const {loadPackagedDarwinJournal}=await import(${JSON.stringify(pathToFileURL(join(dirname(dirname(helper!)), 'darwin-packaged-observer.fixture.mjs')).href)});let errors=[];for(let i=0;i<2;i++){try{await loadPackagedDarwinJournal();errors.push('unexpected success')}catch(e){errors.push(e.message)}}for(const close of closes)await close();try{await loadPackagedDarwinJournal();errors.push('unexpected success')}catch(e){errors.push(e.message)}process.stdout.write(JSON.stringify({errors,opens}))})().catch(e=>{process.stderr.write(e.message);process.exitCode=1});`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const terminal = once(child, 'close');
    const collect = async (stream: NodeJS.ReadableStream) => {
      let text = '';
      for await (const part of stream) {
        text += part.toString();
        if (text.length > 8192) throw new Error('fixture output overflow');
      }
      return text;
    };
    const out = collect(child.stdout!),
      err = collect(child.stderr!);
    const [code] = await terminal;
    expect(code, await err).toBe(0);
    expect(JSON.parse(await out)).toEqual({
      errors: ['ACTUAL_CLOSE_FAULT', 'NATIVE_OBSERVER_UNAVAILABLE', 'NATIVE_OBSERVER_UNAVAILABLE'],
      opens: 1,
    });
  },
  10000
);

it.skipIf(!helper || !workerPath || process.platform !== 'darwin')(
  'naturally returns the acquired worker after owned pre-seed native admission fails',
  async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'darwin-preseed-refusal-')));
    const observer = createDarwinProcessObserver({
      path: helper!,
      sha256: createHash('sha256')
        .update(await readFile(helper!))
        .digest('hex'),
    });
    const batch = await observer.inspect([process.pid]);
    const fact = batch.processes[0];
    if (fact.kind !== 'present') throw new Error('manager missing');
    const manager = darwinBirth(fact.identity),
      time = darwinMonotonicNow();
    const window = {
      startSequence: 0,
      checkpointSequence: 0,
      endSequence: 0,
      startMonotonic: time,
      endMonotonic: time,
    };
    const binding = {
      journalId: 'preseed',
      browserId: 'browser',
      profile: { kind: 'ephemeral' as const },
      browserGeneration: 0,
      reservationNonce: 'nonce',
      runtimeIdentityDigest: 'a'.repeat(64),
      manager,
      bootScope: {
        kind: 'observed' as const,
        value: `darwin-boot:${batch.bootSeconds}:${batch.bootMicroseconds}`,
        sourceIdentityDigest: '0'.repeat(64),
      },
    };
    const initial: JournalSnapshot = {
      schemaVersion: 1,
      kind: 'browser-process-journal',
      provenance: 'recorded-data',
      binding,
      writer: { writerId: 'observer', epoch: 0, kind: 'observer' },
      sequence: 0,
      phase: 'allocated',
      observationWindow: window,
      root: { kind: 'pending' },
      retainedIdentities: [
        {
          identity: manager,
          role: 'manager',
          parent: null,
          association: null,
          currentParent: null,
          acquisitionEpoch: 0,
          firstSeenSequence: 0,
          lastSeenSequence: 0,
          relationWindow: window,
          lifecycle: 'alive',
        },
      ],
      gaps: [],
      firstCause: null,
    };
    try {
      await expect(
        startDarwinJournalWorker({
          workerPath: workerPath!,
          location: {
            parentDirectory: parent,
            parentIdentity: await observeJournalDirectory(parent),
            binding,
          },
          initial,
          artifact: { path: helper!, sha256: '0'.repeat(64) },
          duration: 1000,
          maxGap: 1000,
          ownedLaunch: true,
        })
      ).rejects.toThrow();
      expect(darwinMonotonicNow() - time).toBeLessThan(3000);
      expect(
        (
          await readJournal({
            parentDirectory: parent,
            parentIdentity: await observeJournalDirectory(parent),
            binding,
          })
        ).state
      ).toBe('missing');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  10000
);
