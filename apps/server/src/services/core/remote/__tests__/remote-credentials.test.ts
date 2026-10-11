/**
 * `remote-credentials.ts` over the real encrypted store in a temp data
 * directory (DOR-2086): stored under the right names, encrypted at rest, never
 * in the config file, and a dangling reference resolves to `blocked`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import credentialFixture from '@dork-labs/cloud-api/fixtures/v1/remote/credential-with-edge-proof.json' with { type: 'json' };

import { initConfigManager } from '../../config-manager.js';
import { EncryptedFileCredentialStore, type CredentialStore } from '../../credential-provider.js';
import { RemoteCredentialStoreError, RemoteCredentials } from '../remote-credentials.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';

const VALUE = credentialFixture.value;
const EDGE = credentialFixture.edgeProof.secret;
const ID = credentialFixture.credentialId;

let tmpDir: string;
let store: EncryptedFileCredentialStore;
let credentials: RemoteCredentials;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-credentials-'));
  initConfigManager(tmpDir);
  store = new EncryptedFileCredentialStore(tmpDir);
  credentials = new RemoteCredentials(() => store);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Every file under the data directory, as text. */
function everyFile(dir = tmpDir): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    out += entry.isDirectory() ? everyFile(full) : fs.readFileSync(full, 'utf-8');
  }
  return out;
}

describe('RemoteCredentials', () => {
  it('stores both secrets under names derived from the credential id', async () => {
    const refs = await credentials.put({ credentialId: ID, value: VALUE, edgeProofSecret: EDGE });
    expect(refs).toEqual({
      credentialRef: `file:remote-tunnel-${ID}`,
      edgeProofRef: `file:remote-edge-${ID}`,
    });
    expect(await store.get(`remote-tunnel-${ID}`)).toBe(VALUE);
    expect(await store.get(`remote-edge-${ID}`)).toBe(EDGE);
  });

  it('keeps the secrets out of the config file and encrypted on disk', async () => {
    const refs = await credentials.put({ credentialId: ID, value: VALUE, edgeProofSecret: EDGE });
    updateRemoteState('test', {
      credentialId: ID,
      ...refs,
      edgeProofHeader: 'x-example-edge-proof',
    });
    const config = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8');
    expect(config).toContain(`file:remote-tunnel-${ID}`);
    expect(config).not.toContain(VALUE);
    expect(config).not.toContain(EDGE);
    // Nothing anywhere under the data directory holds either in plain text.
    const all = everyFile();
    expect(all).not.toContain(VALUE);
    expect(all).not.toContain(EDGE);
  });

  it('resolves the record it was stored for', async () => {
    const refs = await credentials.put({ credentialId: ID, value: VALUE, edgeProofSecret: EDGE });
    updateRemoteState('test', { credentialId: ID, ...refs });
    expect(await credentials.resolve(readRemoteState())).toEqual({
      ok: true,
      credentialId: ID,
      value: VALUE,
      edgeProofSecret: EDGE,
    });
  });

  it('answers blocked for a dangling reference, an empty record, or a mismatched one', async () => {
    const refs = {
      credentialRef: `file:remote-tunnel-${ID}`,
      edgeProofRef: `file:remote-edge-${ID}`,
    };
    expect(await credentials.resolve({ credentialId: ID, ...refs })).toEqual({
      ok: false,
      state: 'blocked',
      reason: 'missing_secret',
    });
    expect(
      await credentials.resolve({ credentialId: null, credentialRef: null, edgeProofRef: null })
    ).toEqual({ ok: false, state: 'blocked', reason: 'no_credential' });

    // A hand-edited reference aimed at some other stored secret is refused
    // before the store is read.
    await store.put('anthropic', 'sk-ant-other-secret');
    const aimed = await credentials.resolve({
      credentialId: ID,
      credentialRef: 'file:anthropic',
      edgeProofRef: refs.edgeProofRef,
    });
    expect(aimed).toEqual({ ok: false, state: 'blocked', reason: 'mismatched_reference' });
    expect(JSON.stringify(aimed)).not.toContain('sk-ant');
  });

  it('forgets both secrets, and forgetting twice is fine', async () => {
    await credentials.put({ credentialId: ID, value: VALUE, edgeProofSecret: EDGE });
    await credentials.delete(ID);
    await credentials.delete(ID);
    expect(await store.get(`remote-tunnel-${ID}`)).toBeNull();
    expect(await store.get(`remote-edge-${ID}`)).toBeNull();
  });

  it('stores both or neither, and its error carries no value', async () => {
    const written = new Map<string, string>();
    const failing: CredentialStore = {
      put: async (name, secret) => {
        if (name.startsWith('remote-edge-')) throw new Error(`disk full writing ${secret}`);
        written.set(name, secret);
        return `file:${name}`;
      },
      get: async (name) => written.get(name) ?? null,
      delete: async (name) => {
        written.delete(name);
      },
    };
    const error = await new RemoteCredentials(() => failing)
      .put({ credentialId: ID, value: VALUE, edgeProofSecret: EDGE })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RemoteCredentialStoreError);
    expect(String((error as Error).message)).not.toContain(EDGE);
    expect(written.size).toBe(0);
  });

  it('refuses an id that is not safe as a store name', async () => {
    await expect(
      credentials.put({ credentialId: '../escape', value: VALUE, edgeProofSecret: EDGE })
    ).rejects.toBeInstanceOf(RemoteCredentialStoreError);
  });
});
