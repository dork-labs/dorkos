import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../manager.mjs';
import { processIdentity, reserveProfile } from '../profile-reservation.mjs';
import { bounded, delay } from '../durability-helpers.mjs';
import {
  ownedTree,
  liveOwned,
  distinctOwned,
  signalOwned,
  awaitGone,
} from './resource-process.mjs';

function privateChild(args) {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const inbox = [];
  let waiting;
  let ended = false;
  const exit = new Promise((resolve) => {
    child.once('exit', () => {
      ended = true;
      waiting?.reject(Error('OWNED_CHILD_EXITED'));
      resolve();
    });
    child.once('error', () => {
      ended = true;
      waiting?.reject(Error('OWNED_CHILD_UNAVAILABLE'));
      resolve();
    });
  });
  child.on('message', (message) => {
    if (waiting) {
      const next = waiting;
      waiting = null;
      next.resolve(message);
    } else inbox.push(message);
  });
  return {
    child,
    exit,
    async message(value) {
      if (ended) throw Error('OWNED_CHILD_EXITED');
      const reply = inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve, reject) => {
            waiting = { resolve, reject };
          });
      if (value)
        child.send(value, (error) => {
          if (error) waiting?.reject(Error('OWNED_IPC_UNAVAILABLE'));
        });
      try {
        return await bounded(reply);
      } finally {
        waiting = null;
      }
    },
    async stop(identity) {
      if (!ended) {
        if (identity) signalOwned(identity, 'SIGKILL');
        else child.kill('SIGKILL'); // Only the just-spawned Node handle, before any identity was available.
      }
      await bounded(exit, 3000);
    },
  };
}
async function identityFor(child) {
  let identity;
  await bounded(
    (async () => {
      while (!(identity = processIdentity(child.pid))) await delay(10);
    })(),
    3000
  );
  return identity;
}
async function noOrphans(inventory) {
  try {
    await awaitGone(inventory);
  } catch (error) {
    assert.equal(liveOwned(inventory).length, 0, 'every recorded Chromium identity must exit');
    throw error;
  }
}

/** Observe manager SIGKILL, all attributable Chromium descendants, reservation refusal and recovery shutdown. */
export async function managerDeathInventory({ repoRoot, runtime, profilesDir, fixture }) {
  const worker = privateChild([
    fileURLToPath(new URL('../reservation-contender.mjs', import.meta.url)),
  ]);
  let workerIdentity;
  const inventory = [];
  const manager = new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
  let survivorObserved = false;
  let rootAliveSnapshot;
  let rootExitedBeforeCheck = false;
  let recoveryBrowser;
  try {
    workerIdentity = await identityFor(worker.child);
    assert.equal(
      (
        await worker.message({
          type: 'configure',
          mode: 'browser',
          repoRoot,
          profilesDir,
          fixtureOrigin: fixture.url,
          profileId: 'manager-tree',
        })
      ).type,
      'ready'
    );
    const opened = await worker.message({ type: 'open' });
    assert.equal(opened.type, 'holder');
    const beforeDeath = ownedTree(opened.process);
    if (beforeDeath.length < 2) throw Error('CHROMIUM_DESCENDANTS_UNAVAILABLE');
    inventory.push(...beforeDeath);
    assert.equal(signalOwned(workerIdentity, 'SIGKILL'), true);
    await bounded(worker.exit, 3000);
    rootAliveSnapshot = liveOwned([opened.process]).length === 1;
    if (rootAliveSnapshot) {
      // Async manager startup hashes the executable; Chromium may finish pipe teardown meanwhile.
      // Check reservation synchronously and distinguish recognized refusal from observed root exit.
      let reservation;
      try {
        reservation = reserveProfile(profilesDir, 'manager-tree');
      } catch (error) {
        if (error.code !== 'BROWSER_STILL_RUNNING') throw error;
        survivorObserved = true;
      }
      if (reservation) {
        reservation.release();
        const liveAfterAcquisition = liveOwned([opened.process]);
        if (liveAfterAcquisition.length) {
          const error = new assert.AssertionError({
            actual: liveAfterAcquisition.length,
            expected: 0,
            operator: 'strictEqual',
            message: 'reservation can recover only after original root exits',
          });
          error.observation = {
            outcome: 'unsafe-acquisition',
            managerIdentity: workerIdentity,
            browserIdentity: opened.process,
            originalInventory: distinctOwned(beforeDeath),
            rootAliveSnapshot,
            liveAfterAcquisition: true,
            refusalObserved: false,
          };
          throw error;
        }
        rootExitedBeforeCheck = true;
      }
      signalOwned(opened.process);
    }
    await noOrphans(distinctOwned(inventory));
    recoveryBrowser = await manager.openPersistent('manager-tree');
    const recoveryRoot = manager.ownedProcess(recoveryBrowser.browserId);
    const recoveryTree = ownedTree(recoveryRoot);
    if (recoveryTree.length < 2) throw Error('RECOVERY_DESCENDANTS_UNAVAILABLE');
    inventory.push(...recoveryTree);
    await manager.shutdown();
    const recorded = distinctOwned(inventory);
    await noOrphans(recorded);
    return {
      samples: 1,
      survivorObserved,
      rootAliveSnapshot,
      rootExitedBeforeCheck,
      originalSubjects: beforeDeath.length,
      recoverySubjects: recoveryTree.length,
      subjectIds: [recoveryBrowser.browserId],
      shutdownInventory: recorded,
    };
  } finally {
    await manager.shutdown().catch(() => {});
    // Acquisition can fail after Chromium starts but before its IPC identity reaches us.
    // Snapshot the still-live attributable worker tree before killing that parent.
    if (workerIdentity && processIdentity(workerIdentity.pid)?.birth === workerIdentity.birth) {
      inventory.push(
        ...ownedTree(workerIdentity).filter((entry) => entry.pid !== workerIdentity.pid)
      );
    }
    await worker.stop(workerIdentity);
    const recorded = distinctOwned(inventory);
    for (const owned of recorded) signalOwned(owned, 'SIGKILL');
    if (recorded.length) await noOrphans(recorded);
  }
}

/** A live descendant after its parent dies must prevent no-orphan certification, even after reparenting. */
export async function descendantObserverControl() {
  const script = `const {spawn}=require('node:child_process'); const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); leaf.on('error',()=>process.exit(1)); process.send({pid:leaf.pid}); setInterval(()=>{},1000);`;
  const worker = privateChild(['-e', script]);
  let parent;
  let inventory = [];
  try {
    parent = await identityFor(worker.child);
    const leaf = await worker.message();
    inventory = distinctOwned(ownedTree(parent));
    assert.ok(
      inventory.some((entry) => entry.pid === leaf.pid),
      'real live descendant must be attributed before parent death'
    );
    const leafIdentity = inventory.find((entry) => entry.pid === leaf.pid);
    assert.equal(signalOwned(parent, 'SIGKILL'), true);
    await bounded(worker.exit, 3000);
    assert.ok(
      liveOwned(inventory).some((entry) => entry.pid === leaf.pid),
      'observer must detect live descendant after parent exit'
    );
    await assert.rejects(
      awaitGone(inventory, 150),
      /GATE_TIMEOUT/,
      'a live reparented descendant cannot certify no orphan'
    );
    signalOwned(leafIdentity);
    await noOrphans(inventory);
    return { samples: 1 };
  } finally {
    for (const owned of inventory) signalOwned(owned, 'SIGKILL');
    await worker.stop(parent);
    if (inventory.length) await noOrphans(inventory);
  }
}
