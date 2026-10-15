import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export interface NativeOptions {
  surface: 'cli' | 'desktop';
  receipt: string;
  candidate?: string;
  runtimeReceipt?: string;
  mechanismReceipt?: string;
  mechanismOnly: boolean;
}
export interface WorkerOptions extends NativeOptions {
  output: string;
  sandbox: string;
  operationDeadline: number;
}
/** Read an explicit command argument without selecting a fallback value. */
export function argument(name: string, required = true) {
  const at = process.argv.indexOf(name);
  if (at < 0) {
    assert(!required, name + ' required');
    return undefined;
  }
  assert(process.argv[at + 1] && !process.argv[at + 1]!.startsWith('--'), name + ' value required');
  return process.argv[at + 1]!;
}
/** Require explicit surface and artifact receipt inputs for native qualification. */
export function parseOptions(): NativeOptions {
  const surface = argument('--surface');
  assert(surface === 'cli' || surface === 'desktop');
  const mechanismOnly = process.argv.includes('--mechanism-only');
  assert(!mechanismOnly || surface === 'desktop');
  const result: NativeOptions = {
    surface,
    receipt: path.resolve(argument('--receipt')!),
    mechanismOnly,
  };
  if (surface === 'desktop') {
    result.candidate = path.resolve(argument('--candidate')!);
    result.runtimeReceipt = path.resolve(argument('--runtime-receipt')!);
    if (!mechanismOnly) result.mechanismReceipt = path.resolve(argument('--mechanism-receipt')!);
  }
  return result;
}
/** A worker may only be started by the real lane-owning outer ancestor. */
export async function workerOptions(): Promise<WorkerOptions> {
  const options = parseOptions(),
    output = path.resolve(argument('--output')!),
    sandbox = path.resolve(argument('--sandbox')!);
  for (const file of [root, output, sandbox]) assert.equal(await realpath(file), file);
  assert(output.startsWith(path.join(root, '.dork/local-browser/native-proof') + path.sep));
  const admission = JSON.parse(await readFile(path.join(output, 'admission.json'), 'utf8'));
  assert.deepEqual(admission.options, options);
  assert.equal(admission.sandbox, sandbox);
  assert.equal(admission.root, root);
  assert.equal(admission.output, output);
  assert(
    Number.isSafeInteger(admission.operationDeadline) && Date.now() < admission.operationDeadline
  );
  const rows = (await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 2000 }))
    .stdout;
  const parents = new Map(
    rows.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
      return match ? [[Number(match[1]), Number(match[2])] as [number, number]] : [];
    })
  );
  let cursor = process.pid;
  const ancestors = new Set<number>();
  while (parents.has(cursor) && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = parents.get(cursor)!;
  }
  assert(ancestors.has(admission.outerPid), 'Actual native outer ancestor required');
  return { ...options, output, sandbox, operationDeadline: admission.operationDeadline };
}
