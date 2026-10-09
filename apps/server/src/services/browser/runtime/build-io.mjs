import { Buffer } from 'node:buffer';
import process from 'node:process';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const refuse = (code) => new Error(code);
export async function readOriginal(path, max) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let first, value;
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size <= 0n ||
      before.size > BigInt(max) ||
      before.uid !== BigInt(process.getuid())
    )
      throw refuse('CUSTODIAN_ORIGINAL_FILE');
    value = await fd.readFile();
    const after = await fd.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      value.length !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      before.dev !== named.dev ||
      before.ino !== named.ino
    )
      throw refuse('CUSTODIAN_FILE_CHANGED');
  } catch (error) {
    first = { value: error };
  } finally {
    try {
      await fd.close();
    } catch (error) {
      first ??= { value: error };
    }
  }
  if (first) throw first.value;
  return value;
}
export async function save(path, bytes) {
  const fd = await open(path, 'wx', 0o600);
  let first;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const row = await fd.write(bytes, offset, bytes.length - offset, null);
      if (!row.bytesWritten) throw refuse('CUSTODIAN_WRITE_PROGRESS');
      offset += row.bytesWritten;
    }
    await fd.sync();
  } catch (value) {
    first = { value };
  } finally {
    try {
      await fd.close();
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}
// Fixed original tool chain, full wait/stdout EOF/stderr EOF/close and original
// file-write jobs. This builds artifacts; it is not a runtime custody backend.
export async function tool(
  directory,
  name,
  executable,
  args,
  environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
) {
  let out, err, child, closed, first;
  const jobs = new Set();
  const captures = [Buffer.alloc(0), Buffer.alloc(0)],
    counts = [0, 0],
    eof = [false, false];
  let code, signal;
  const retain = (p) => {
    jobs.add(p);
    p.then(
      () => jobs.delete(p),
      (value) => {
        first ??= { value };
        jobs.delete(p);
      }
    );
    return p;
  };
  try {
    out = await open(join(directory, name + '.stdout.raw'), 'wx', 0o600);
    err = await open(join(directory, name + '.stderr.raw'), 'wx', 0o600);
    child = spawn(executable, args, {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolveClose) => {
      child.on('error', (value) => {
        first ??= { value };
      });
      child.on('exit', (c, s) => {
        code = c;
        signal = s;
      });
      child.on('close', resolveClose);
    });
    for (const [i, stream, file] of [
      [0, child.stdout, out],
      [1, child.stderr, err],
    ]) {
      stream.on('error', (value) => {
        first ??= { value };
      });
      stream.on('end', () => {
        eof[i] = true;
      });
      stream.on('data', (original) => {
        const bytes = Buffer.from(original);
        stream.pause();
        counts[i] += bytes.length;
        captures[i] = Buffer.concat([captures[i], bytes]).subarray(-262144);
        retain(
          (async () => {
            try {
              if (counts[i] > 33554432) {
                first ??= { value: refuse('CUSTODIAN_TOOL_RAW_BOUND') };
                return;
              }
              let offset = 0;
              while (offset < bytes.length) {
                const row = await file.write(bytes, offset, bytes.length - offset, null);
                if (!row.bytesWritten) throw refuse('CUSTODIAN_TOOL_WRITE');
                offset += row.bytesWritten;
              }
            } finally {
              stream.resume();
            }
          })()
        );
      });
    }
    await closed;
    while (jobs.size) await Promise.allSettled([...jobs]);
    if (code !== 0 || signal || !eof[0] || !eof[1])
      first ??= { value: refuse('CUSTODIAN_ORIGINAL_TOOL_RETURN') };
  } catch (value) {
    first ??= { value };
  } finally {
    // Once a child exists, original close/EOF and every entered I/O job must join.
    if (closed) await closed;
    while (jobs.size) await Promise.allSettled([...jobs]);
    const result = await Promise.allSettled([out?.sync(), err?.sync()]);
    for (const row of result) if (row.status === 'rejected') first ??= { value: row.reason };
    const closure = await Promise.allSettled([out?.close(), err?.close()]);
    for (const row of closure) if (row.status === 'rejected') first ??= { value: row.reason };
  }
  try {
    await save(
      join(directory, name + '.RETURN.json'),
      Buffer.from(
        JSON.stringify({
          code,
          signal,
          stdoutEOF: eof[0],
          stderrEOF: eof[1],
          stdoutBytes: counts[0],
          stderrBytes: counts[1],
          hasFailure: !!first,
        }) + '\n'
      )
    );
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
  return { stdout: captures[0], stderr: captures[1] };
}
