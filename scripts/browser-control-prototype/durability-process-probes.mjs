import assert from 'node:assert/strict';
import { NegativeObservation } from './durability/negative-observation.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, lstat, readlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './manager.mjs';
import { processIdentity, reserveProfile } from './profile-reservation.mjs';
import { bounded, delay } from './durability-helpers.mjs';
const reservationModule = new URL('./profile-reservation.mjs', import.meta.url).href;
const contender = fileURLToPath(new URL('./reservation-contender.mjs', import.meta.url));
function child(script = contender) {
  const process = spawn(globalThis.process.execPath, [script], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const inbox = [];
  let waiter;
  let ended = false;
  const exited = new Promise((resolve) => {
    process.once('exit', () => {
      ended = true;
      resolve();
    });
  });
  process.on('message', (message) => {
    if (waiter) {
      const current = waiter;
      waiter = null;
      current.resolve(message);
    } else inbox.push(message);
  });
  process.on('error', () => {
    if (waiter) {
      waiter.reject(Error('CHILD_SPAWN_FAILED'));
      waiter = null;
    }
  });
  process.on('exit', () => {
    if (waiter) {
      waiter.reject(Error('CHILD_EXITED'));
      waiter = null;
    }
  });
  return {
    process,
    async message(message) {
      if (ended) throw Error('CHILD_EXITED');
      const next = inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve, reject) => {
            waiter = { resolve, reject };
          });
      process.send(message);
      return bounded(next);
    },
    async kill() {
      if (!ended) process.kill('SIGKILL');
      await bounded(exited, 3000);
    },
    async close() {
      if (ended) return;
      const reply = await this.message({ type: 'close' });
      assert.equal(reply.type, 'closed');
      await bounded(exited, 3000);
    },
  };
}
async function profileSnapshot(directory) {
  const entries = [];
  async function walk(path, relative = '') {
    for (const name of (await readdir(path)).sort()) {
      const file = join(path, name);
      const label = join(relative, name);
      const info = await lstat(file);
      entries.push([
        label,
        info.mode,
        info.isSymbolicLink()
          ? await readlink(file)
          : info.isFile()
            ? createHash('sha256')
                .update(await readFile(file))
                .digest('hex')
            : 'directory',
      ]);
      if (info.isDirectory()) await walk(file, label);
    }
  }
  await walk(directory);
  return entries;
}

/** Separate processes contend on one reservation; a rejected attempt leaves profile bytes untouched. */
export async function probeExclusion({ profilesDir, moduleUrl = reservationModule }) {
  await mkdir(join(profilesDir, 'exclusive'), { recursive: true, mode: 0o700 });
  await writeFile(join(profilesDir, 'exclusive', 'sentinel'), 'fake-state', { mode: 0o600 });
  const before = await profileSnapshot(join(profilesDir, 'exclusive'));
  const config = {
    type: 'configure',
    mode: 'reservation',
    profilesDir,
    profileId: 'exclusive',
    reservationModule: moduleUrl,
  };
  const contenders = [child(), child()];
  try {
    for (const contender of contenders)
      assert.equal((await contender.message(config)).type, 'ready');
    const results = await Promise.all(
      contenders.map((contender) => contender.message({ type: 'open' }))
    );
    if (
      moduleUrl !== reservationModule &&
      results.length === 2 &&
      results.every((result) => result.type === 'holder')
    )
      throw new NegativeObservation('per-process-reservation', results.length);
    assert.equal(results.filter((r) => r.type === 'holder').length, 1);
    assert.equal(results.filter((r) => r.type === 'refused').length, 1);
    assert.ok(
      ['PROFILE_IN_USE', 'RECOVERY_BUSY'].includes(results.find((r) => r.type === 'refused').code)
    );
    assert.deepEqual(await profileSnapshot(join(profilesDir, 'exclusive')), before);
    for (const contender of contenders) await contender.close();
    const reservation = reserveProfile(profilesDir, 'exclusive');
    reservation.release();
    return { samples: 2 };
  } finally {
    await Promise.all(contenders.map((contender) => contender.kill()));
  }
}

/** Dead manager does not authorize stealing its still-running owned Chromium process. */
export async function probeCrash({ repoRoot, runtime, profilesDir, fixture }) {
  const worker = child();
  let browserProcess;
  try {
    const config = {
      type: 'configure',
      mode: 'browser',
      repoRoot,
      profilesDir,
      fixtureOrigin: fixture.url,
      profileId: 'crashed-A',
    };
    assert.equal((await worker.message(config)).type, 'ready');
    const opened = await worker.message({ type: 'open' });
    assert.equal(opened.type, 'holder');
    browserProcess = opened.process;
    assert.ok(browserProcess?.birth);
    await worker.kill();
    assert.equal(processIdentity(worker.process.pid), null);
    // Chromium may itself exit when the Playwright pipe closes. Observe rather than invent survival.
    const survivor = processIdentity(browserProcess.pid);
    if (survivor?.birth === browserProcess.birth) {
      assert.throws(() => reserveProfile(profilesDir, 'crashed-A'), {
        code: 'BROWSER_STILL_RUNNING',
      });
      globalThis.process.kill(browserProcess.pid, 'SIGTERM');
      await bounded(
        (async () => {
          while (processIdentity(browserProcess.pid)?.birth === browserProcess.birth)
            await delay(25);
        })(),
        5000
      );
    }
    const manager = new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
    try {
      const browser = await manager.openPersistent('crashed-A');
      assert.equal(browser.profileId, 'crashed-A');
    } finally {
      await manager.shutdown();
    }
    return { samples: 1, survivorObserved: survivor?.birth === browserProcess.birth };
  } finally {
    await worker.kill();
    if (browserProcess && processIdentity(browserProcess.pid)?.birth === browserProcess.birth)
      globalThis.process.kill(browserProcess.pid, 'SIGKILL');
  }
}

/** Two independent managers attempt the same actual Chromium profile at one IPC start barrier. */
export async function probeBrowserRace({
  repoRoot,
  profilesDir,
  fixture,
  secondContenderPath = contender,
}) {
  const profileDir = join(profilesDir, 'browser-race');
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const sentinel = join(profileDir, 'unchanged-sentinel');
  await writeFile(sentinel, 'fake-race-state', { mode: 0o600 });
  const sentinelBefore = await readFile(sentinel);
  const config = {
    type: 'configure',
    mode: 'browser',
    repoRoot,
    profilesDir,
    fixtureOrigin: fixture.url,
    profileId: 'browser-race',
  };
  const contenders = [child(), child(secondContenderPath)];
  let processes = [];
  try {
    for (const contender of contenders)
      assert.equal((await contender.message(config)).type, 'ready');
    const results = await Promise.all(
      contenders.map((contender) => contender.message({ type: 'open' }))
    );
    processes = results
      .filter((result) => result.type === 'holder')
      .map((result) => result.process);
    assert.equal(processes.length, 1, 'exactly one actual Chromium holder');
    assert.equal(results.filter((result) => result.type === 'refused').length, 1);
    assert.ok(
      ['PROFILE_IN_USE', 'BROWSER_STILL_RUNNING', 'RECOVERY_BUSY'].includes(
        results.find((result) => result.type === 'refused').code
      ),
      'first startup refusal must prove profile exclusion'
    );
    const owned = processes[0];
    assert.equal(processIdentity(owned.pid)?.birth, owned.birth, 'winning Chromium is alive');
    assert.deepEqual(await readFile(sentinel), sentinelBefore);
    const reservationPath = join(profilesDir, '.reservations', 'browser-race.json');
    const reservationBefore = await readFile(reservationPath);
    const loser = contenders[results.findIndex((result) => result.type === 'refused')];
    const refused = await loser.message({ type: 'open' });
    assert.equal(refused.type, 'refused');
    assert.ok(['PROFILE_IN_USE', 'BROWSER_STILL_RUNNING', 'RECOVERY_BUSY'].includes(refused.code));
    assert.deepEqual(
      await readFile(sentinel),
      sentinelBefore,
      'loser leaves seeded sentinel intact'
    );
    assert.deepEqual(
      await readFile(reservationPath),
      reservationBefore,
      'loser leaves winning ownership intact'
    );
    assert.equal(processIdentity(owned.pid)?.birth, owned.birth);
    for (const contender of contenders) await contender.close();
    assert.equal(processIdentity(owned.pid), null);
    return { samples: 2 };
  } finally {
    // Close managers first; precise recorded PID/birth cleanup is a last resort, never a process group.
    for (const contender of contenders) {
      try {
        await contender.close();
      } catch {
        await contender.kill();
      }
    }
    for (const owned of processes) {
      if (owned && processIdentity(owned.pid)?.birth === owned.birth)
        globalThis.process.kill(owned.pid, 'SIGKILL');
    }
  }
}
