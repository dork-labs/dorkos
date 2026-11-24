import { readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import type {} from '../../configuration.js';
import { reserveProfile } from '../../profiles/reservation.js';
import { parseProfileId } from '../../ids.js';
import { parseBrowserResult } from '../../contracts.js';
import { ownFixtureManager } from '../fixture-manager-custody.js';
import {
  fixtureJSON,
  requestId,
  profileId,
  fixture,
  originals,
  gone,
  restart,
  finishFixture,
} from './supervisor-crash-recovery.fixtures.js';

it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'original manager death refuses its live root before profile mutation and reconciles only recorded descendants after loss',
  async () => {
    const f = await fixture();
    let observed = false,
      failed = false,
      primary: unknown;
    try {
      const seed = join(f.directory, 'seed.json'),
        script = join(f.directory, 'manager.cjs');
      await writeFile(seed, JSON.stringify(f.config), { mode: 0o600 });
      const module = new URL('../../dist/engine.js', import.meta.url).href;
      await writeFile(
        script,
        `(async()=>{
      const fs=require('node:fs/promises');const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
      config.clock={monotonicNow:()=>performance.now(),wallNow:()=>Date.now()};
      config.processes={observe:async()=>({status:'unknown'}),descendants:async()=>({status:'unknown',identities:[]})};
      config.policy={authorizeAction:async()=> 'allowed',verifyBrokerLease:async()=> 'unknown'};
      const {constructOwnedBrowserEngine}=await import(${JSON.stringify(module)});
      const engine=constructOwnedBrowserEngine(config,{registerBirth(){},refuseBirth(){}});
      let closing; const close=()=>closing??=(async()=>{try{await engine.shutdown()}finally{if(process.connected)process.disconnect()}})();
      process.on('message',()=>{void close().catch(()=>{process.exitCode=1})});
      process.once('disconnect',()=>{void close().catch(()=>{process.exitCode=1})});
      try {
      const opened=await engine.open({kind:'open',mode:'persistent',profileId:${JSON.stringify(profileId)},requestId:${JSON.stringify(requestId())}});
      const input=await engine.input({kind:'input',binding:opened.tab,requestId:${JSON.stringify(requestId())},steps:[{kind:'click',x:60,y:45,button:'left'}]});
      if(input.outcome!=='completed')throw new Error('FIXTURE_INPUT_NOT_COMPLETED');
      process.send(opened);
      } catch(primary) { await close().catch(()=>{}); throw primary; }
    })().catch(error=>{console.error(error);process.exitCode=1;if(process.connected)process.disconnect()});`,
        { mode: 0o600 }
      );
      const manager = spawn(process.execPath, [script, seed], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const managerOwner = ownFixtureManager(manager);
      f.custody.adopt(
        'manager:close',
        managerOwner,
        (owner) => owner.close(),
        (value) =>
          !!value && typeof value === 'object' && 'observed' in value && value.observed === true
      );
      const opened = parseBrowserResult(await managerOwner.ready());
      if (opened.kind !== 'opened') throw new Error('FIXTURE_OPENED_RESULT_REQUIRED');
      await expect.poll(f.effects).toBe(1);
      const snapshot = await originals(f);
      expect(snapshot.binding.manager.pid).toBe(manager.pid);
      const marker = join(f.config.dataDir, 'profiles', profileId, 'fixture-marker');
      await writeFile(marker, 'original-value', { mode: 0o600 });
      const ownerPath = join(f.config.dataDir, 'reservations', profileId, 'owner.json');
      const owner = await readFile(ownerPath, 'utf8');
      // Remove only this fictitious profile's native lock to exercise the absent-lock mutant.
      const nativeLock = join(f.config.dataDir, 'profiles', profileId, 'SingletonLock');
      expect((await lstat(nativeLock)).isSymbolicLink()).toBe(true);
      await unlink(nativeLock);
      await expect(lstat(nativeLock)).rejects.toMatchObject({ code: 'ENOENT' });
      const currentManager = await f.native.identity(process.pid);
      if (!currentManager) throw new Error('FIXTURE_RECOVERY_MANAGER_UNAVAILABLE');
      // Exact journal metadata automatically reaches the genuine native observer; no synthetic recovery callback.
      await expect(
        reserveProfile(f.config, f.config.dataDir, parseProfileId(profileId), currentManager)
      ).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
      expect(await readFile(ownerPath, 'utf8')).toBe(owner);
      await expect(lstat(nativeLock)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(marker, 'utf8')).toBe('original-value');
      // Signal only this actual original fixture-owned manager child; never a PID from metadata.
      expect(managerOwner.crash()).toBe(true);
      expect(await f.custody.operation('manager:returned', () => managerOwner.returned, 2000)).toBe(
        true
      );
      await gone(
        f,
        snapshot.retainedIdentities.map((value) => value.identity)
      );
      observed = true;
      await restart(f, opened);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finishFixture(f, 'manager', observed, failed, primary);
    }
  },
  45000
);
