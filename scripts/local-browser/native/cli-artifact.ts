/** Validate an explicit passed CLI artifact receipt against exact archive bytes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { captureProofSource } from '../source-snapshot.js';
import { root as sourceRoot } from './options.js';
import { gunzipSync } from 'node:zlib';

export interface QualifiedArtifact {
  receiptPath: string;
  tarball: string;
  sha256: string;
  version: string;
  sourceFingerprint: string;
}
/** Input is explicit: no latest fallback and no promotion of a failed prior proof. */
export async function readQualifiedArtifact(receiptPath: string): Promise<QualifiedArtifact> {
  assert.equal(await realpath(receiptPath), receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  // eslint-disable-next-line no-restricted-syntax -- Standalone proof binds the archive to current source without app startup.
  const proofEnvironment = process.env;
  assert.equal(
    (await captureProofSource(sourceRoot, proofEnvironment)).fingerprint,
    receipt.package.sourceFingerprint,
    'Artifact predates current frozen source'
  );
  assert.equal(receipt.status, 'passed-bounded-cli-proof');
  assert.match(receipt.package.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.package.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(receipt.sourceCustody.fingerprint, receipt.package.sourceFingerprint);
  assert.equal(receipt.sourceCustody.snapshots['after-proof'].unchanged, true);
  const root = await realpath(path.join(path.dirname(receiptPath), 'artifacts'));
  assert.equal(path.basename(receipt.package.filename), receipt.package.filename);
  const tarball = await realpath(path.join(root, receipt.package.filename));
  assert(tarball.startsWith(root + path.sep));
  const bytes = await readFile(tarball);
  assert.equal(bytes.length, receipt.package.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.package.sha256);
  // Read the manifest from the exact hash-qualified archive, never infer version from filename.
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const manifests: Buffer[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString()
        .replace(/\0.*$/, '');
    assert.match(field(124, 12).trim(), /^[0-7]+$/);
    const size = parseInt(field(124, 12).trim(), 8);
    const checksum = [...header].reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    assert.equal(checksum, parseInt(field(148, 8).trim(), 8), 'Archive header checksum');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    assert(offset + 512 + size <= tar.length);
    if (name === 'package/package.json') {
      assert([0, 48].includes(header[156]));
      assert(size < 1024 * 1024);
      manifests.push(tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(manifests.length, 1, 'Exactly one ordinary package manifest required');
  const manifest = JSON.parse(manifests[0].toString());
  assert.equal(manifest.name, 'dorkos');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  if (receipt.package.version !== undefined)
    assert.equal(receipt.package.version, manifest.version);
  receipt.package.version = manifest.version;
  return {
    receiptPath,
    tarball,
    sha256: receipt.package.sha256,
    version: receipt.package.version,
    sourceFingerprint: receipt.package.sourceFingerprint,
  };
}
