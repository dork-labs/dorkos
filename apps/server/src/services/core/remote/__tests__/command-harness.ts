/**
 * Shared set-up for the managed remote access command tests (DOR-2086): a real
 * config file and encrypted store in a temp directory, a real journal over an
 * in-memory database, an offline Cloud, and a fake tunnel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';

import { initConfigManager } from '../../config-manager.js';
import { EncryptedFileCredentialStore, type CredentialStore } from '../../credential-provider.js';
import type { ManagedStartInput, ManagedStartResult } from '../managed-forwarding.js';
import { CommandDispatcher, type CommandLink } from '../command-dispatcher.js';
import { CommandJournal } from '../command-journal.js';
import { RemoteCredentials } from '../remote-credentials.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';
import { FakeCloud } from './fake-cloud.js';

/** The instance id the signed-in fixture names. */
export const INSTANCE_ID = 'inst_0001';
/** The credential the seeded computer holds. */
export const CURRENT = {
  credentialId: 'cred_0001',
  value: 'crv_0001_opaque',
  edgeProofSecret: 'eps_0001_opaque_0000000000000000000000000000',
  header: 'x-example-edge-proof',
  hosts: ['example-instance.remote.invalid', 'machine.customer.invalid'],
};

/** A tunnel that records what it was asked and opens whatever it is given. */
export function fakeTunnel() {
  const tunnel = {
    phase: null as null | 'opening' | 'open' | 'draining',
    /** Hostnames the next open refuses to serve. */
    refuseHosts: [] as string[],
    /** When set, the next open fails with this. */
    failWith: null as Extract<ManagedStartResult, { ok: false }> | null,
    startManaged: vi.fn(async (input: ManagedStartInput): Promise<ManagedStartResult> => {
      if (tunnel.failWith) {
        const failure = tunnel.failWith;
        tunnel.failWith = null;
        tunnel.phase = null;
        return failure;
      }
      tunnel.phase = 'open';
      const hosts = input.hosts
        .map((host) => host.toLowerCase())
        .filter((host) => !tunnel.refuseHosts.includes(host));
      return { ok: true, url: `https://${hosts[0]}`, hosts, generation: input.generation };
    }),
    closeManaged: vi.fn(async (_options: { immediate: boolean; drainDeadlineMs?: number }) => {
      tunnel.phase = null;
    }),
    getManagedPhase: () => tunnel.phase,
  };
  return tunnel;
}

/** One test's world. */
export interface CommandWorld {
  tmpDir: string;
  db: Db;
  cloud: FakeCloud;
  store: CredentialStore;
  credentials: RemoteCredentials;
  tunnel: ReturnType<typeof fakeTunnel>;
  journal: CommandJournal;
  dispatcher: CommandDispatcher;
  link: CommandLink;
  settled: ReturnType<typeof vi.fn>;
  /** Build a fresh journal and dispatcher over the same database, as a restart does. */
  restart: () => void;
  cleanup: () => void;
}

/** Build a world. `enrolled` seeds a person's enrolment and a stored credential. */
export async function commandWorld(options: { enrolled?: boolean } = {}): Promise<CommandWorld> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-commands-'));
  initConfigManager(tmpDir);
  const db = createDb(':memory:');
  runMigrations(db);
  const cloud = new FakeCloud();
  const store = new EncryptedFileCredentialStore(tmpDir);
  const credentials = new RemoteCredentials(() => store);
  const tunnel = fakeTunnel();
  const settled = vi.fn();

  if (options.enrolled ?? true) {
    const refs = await credentials.put({
      credentialId: CURRENT.credentialId,
      value: CURRENT.value,
      edgeProofSecret: CURRENT.edgeProofSecret,
    });
    updateRemoteState('test', {
      mode: 'managed',
      enrolmentId: 'enr_0001',
      consentVersion: '2026-09-15',
      instanceId: INSTANCE_ID,
      credentialId: CURRENT.credentialId,
      fingerprint: 'sha256:0',
      hosts: CURRENT.hosts,
      edgeProofHeader: CURRENT.header,
      ...refs,
    });
  }

  const build = () => {
    const journal = new CommandJournal(db);
    const dispatcher = new CommandDispatcher({
      journal,
      tunnelManager: tunnel,
      remoteCredentials: credentials,
      readRemoteState,
      updateRemoteState,
      onSettled: settled,
    });
    return { journal, dispatcher };
  };
  const world: CommandWorld = {
    tmpDir,
    db,
    cloud,
    store,
    credentials,
    tunnel,
    ...build(),
    link: { context: cloud.capture()!, instanceId: INSTANCE_ID },
    settled,
    restart: () => Object.assign(world, build()),
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
  return world;
}
