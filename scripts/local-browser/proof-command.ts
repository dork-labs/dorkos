/** Run one proof build/install command with a bounded, privately identified process group. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { bounded, ownedChromeCleanup } from './owned-chrome-cleanup.js';

interface ProofCommandOptions {
  name: string;
  args: string[];
  cwd: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

/** Preserve the identifying entry and logs if physical closure cannot be proved. */
export async function runProofCommand(options: ProofCommandOptions): Promise<string> {
  const entry = options.log + '.command.cjs';
  await writeFile(
    entry,
    "const {spawn}=require('node:child_process');const child=spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit'});child.once('error',error=>{console.error(error);process.exitCode=1});child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0)});\n",
    { mode: 0o600 }
  );
  const log = createWriteStream(options.log);
  const child = spawn(process.execPath, [entry, options.name, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  // Capture spawn failures immediately while the initial ownership census awaits ps.
  void exited.catch(() => undefined);
  let stdout = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    log.write(chunk);
  });
  child.stderr!.on('data', (chunk: Buffer) => log.write(chunk));
  let cleanup: ReturnType<typeof ownedChromeCleanup> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  try {
    assert(child.pid, 'The proof command must start an owned process');
    cleanup = ownedChromeCleanup(child.pid, entry);
    await cleanup.capture();
    timer = setInterval(() => {
      void cleanup?.capture().catch(() => undefined);
    }, 500);
    const code = await bounded(exited, 300_000, `${options.name} proof command`);
    assert.equal(code, 0, `${options.name} exited ${code}; inspect ${options.log}`);
    return stdout;
  } finally {
    clearInterval(timer);
    try {
      if (cleanup) await bounded(cleanup.close(), 60_000, 'Proof command physical cleanup');
      closed = true;
    } finally {
      await bounded(new Promise<void>((resolve) => log.end(resolve)), 2_000, 'Proof log close');
      if (closed) await rm(entry);
    }
  }
}
