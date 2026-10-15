import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
export const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Decode explicit proof evidence; callers validate admission fields before use. */
export const json = async <T = Record<string, unknown>>(file: string): Promise<T> =>
  JSON.parse(await readFile(file, 'utf8')) as T;
/** Hash an explicit proof input without loading or changing its contents. */
export async function sha(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
/** Write new proof evidence exclusively with private permissions. */
export async function writeJson(file: string, value: unknown) {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
/** Reserve an available numeric loopback port for one owned fixture. */
export async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export interface RuntimeReceipt {
  status: string;
  candidate: string;
  sourceSHA: string;
  checks: {
    shippedLibrary: { version: string };
    physicalClosure: { remainingOwnedProcesses: string[] };
  };
  candidateDigest: { executable: string; appArchive: string };
}
export interface InspectorReceipt extends Record<string, unknown> {
  status: string;
  finalFence: { failed: unknown; guardAttested: boolean };
  forkFenceError?: string;
  wrapperRetainedUntilOwnedAppPhysicalClosure: boolean;
  guard: { afterServerReady: { tests: { guardSelfTests: number; identitiesUnchanged: boolean } } };
  nativeContinuation?: { actualCandidateRenderer: boolean };
}
export interface MechanismOuterReceipt {
  status: string;
  heldLane?: unknown;
  physicalClosure: boolean;
  worker: {
    status: string;
    artifact: {
      candidate: string;
      archive: { archiveSha256: string };
      bundle: unknown;
      sourceFingerprint: string;
    };
    probe: InspectorReceipt;
  };
}
