/** Validate actual standard-command provenance and freeze every built payload. */
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { json, sha } from './resources.js';
import { captureDesktopInputs, builtInputs, assertBuiltPayloads } from './build-inputs.js';
export interface CommandReceipt extends Record<string, unknown> {
  status: string;
  root: string;
  command: string;
  candidate: string;
  heldLane?: unknown;
  inputs?: Awaited<ReturnType<typeof captureDesktopInputs>>;
  inputHashes: Record<string, string>;
  commands: {
    name: string;
    args: readonly string[];
    log: string;
    logSha256: string;
    exitCode: number;
    physicallyClosed: boolean;
  }[];
  previous?: { path: string; sha256: string };
  builtInputs?: Record<string, string>;
  archive?: Awaited<ReturnType<typeof import('./bundle.js').archiveManifest>>;
  bundle?: Awaited<ReturnType<typeof import('./bundle.js').bundleManifest>>;
}
export const standardCommands = {
  'shared-build': ['--filter', '@dorkos/shared', 'build'],
  'desktop-build': ['--filter', '@dorkos/desktop', 'build'],
  'desktop-pack': [
    '--filter',
    '@dorkos/desktop',
    'exec',
    'electron-builder',
    '--dir',
    '--config.npmRebuild=false',
    '--config.mac.notarize=false',
  ],
} as const;
/** Validate the successful normal-command chain and its frozen built payloads. */
export async function readBuildCustody(root: string, file: string, candidate: string) {
  assert.equal(await realpath(file), file);
  const receipt = await json<CommandReceipt>(file);
  assert.equal(receipt.root, root);
  assert.equal(receipt.status, 'passed-normal-desktop-command');
  assert.equal(receipt.command, 'desktop-pack');
  assert.equal(receipt.candidate, candidate);
  assert(!receipt.heldLane);
  const expected = Object.values(standardCommands);
  assert.equal(receipt.commands.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const command = receipt.commands[index];
    assert.equal(command.name, 'pnpm');
    assert.deepEqual(command.args, expected[index]);
    assert.equal(command.exitCode, 0);
    assert.equal(command.physicallyClosed, true);
    assert.equal(await sha(command.log), command.logSha256);
  }
  for (const [input, digest] of Object.entries(receipt.inputHashes))
    assert.equal(await sha(input), digest);
  assert.deepEqual(await captureDesktopInputs(root), receipt.inputs);
  assert.deepEqual(await builtInputs(root), receipt.builtInputs);
  assert(receipt.archive && receipt.builtInputs && receipt.bundle && receipt.inputs);
  assertBuiltPayloads(receipt.builtInputs, receipt.archive);
  return {
    ...receipt,
    archive: receipt.archive,
    builtInputs: receipt.builtInputs,
    bundle: receipt.bundle,
    inputs: receipt.inputs,
  };
}
