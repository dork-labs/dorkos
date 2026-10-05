import { createHash } from 'node:crypto';
import { open, lstat, readFile, realpath, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { z } from 'zod';
const retainedExecutableReads = new Set<FileHandle>();
let executableCloseUncertain = false;
async function hashExecutable(path: string): Promise<string> {
  if (executableCloseUncertain) throw new Error('EXECUTABLE_READ_CLOSE_UNCERTAIN');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedExecutableReads.add(file);
  let failed = false,
    primary: unknown,
    digest = '';
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 2147483648n)
      throw new Error('EXECUTABLE_READ_UNAVAILABLE');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let total = 0;
    for (;;) {
      const result = await file.read(buffer, 0, Math.min(buffer.length, 2147483649 - total), total);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > 2147483648) throw new Error('EXECUTABLE_READ_OVERFLOW');
      hash.update(buffer.subarray(0, result.bytesRead));
    }
    const after = await file.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      BigInt(total) !== before.size ||
      !named.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.size !== after.size ||
      named.mtimeNs !== after.mtimeNs ||
      named.ctimeNs !== after.ctimeNs
    )
      throw new Error('EXECUTABLE_READ_CHANGED');
    digest = hash.digest('hex');
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await file.close();
    retainedExecutableReads.delete(file);
  } catch (error) {
    executableCloseUncertain = true;
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return digest;
}

const runtimeSchema = z
  .object({
    executablePath: z.string(),
    executableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    observedVersion: z.literal('153.0.8010.12'),
  })
  .strict();
export async function verifiedFixtureRuntime(input: string) {
  const runtime = runtimeSchema.parse(JSON.parse(await readFile(input, 'utf8')));
  if ((await realpath(runtime.executablePath)) !== runtime.executablePath)
    throw new Error('RUNTIME_PATH_CHANGED');
  if ((await hashExecutable(runtime.executablePath)) !== runtime.executableSHA256)
    throw new Error('RUNTIME_DIGEST_CHANGED');
  return runtime;
}
