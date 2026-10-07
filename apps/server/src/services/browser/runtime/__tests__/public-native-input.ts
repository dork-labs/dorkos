import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';
import { z } from 'zod';
const retainedOriginalFiles = new Set<FileHandle>();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const absolute = z.string().max(4096).refine(isAbsolute);
/** Files-only invocation receipt. It supplies no browser/config/native or actor authority. */
export const PublicNativeInputSchema = z
  .object({
    kind: z.literal('production-public-native-acceptance'),
    home: absolute,
    cliEntry: absolute,
    cliSHA256: digest,
    emittedGuard: absolute,
    emittedGuardSHA256: digest,
    workspaceId: z.string().min(1).max(128),
    email: z.literal('public-native@dork.test'),
    password: z.literal('public-native-fixture-password-only'),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export type PublicNativeInput = z.infer<typeof PublicNativeInputSchema>;
/** Each original file handle closes independently; exact body failure survives close failure. */
export async function boundedOriginalFile(
  path: string,
  cap: number,
  admit: () => void = () => {}
): Promise<Buffer> {
  admit();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  retainedOriginalFiles.add(handle);
  let failure: { value: unknown } | undefined, result: Buffer | undefined;
  try {
    admit();
    const before = await handle.stat({ bigint: true });
    admit();
    if (!before.isFile() || before.size < 1n || before.size > BigInt(cap))
      throw new Error('PUBLIC_NATIVE_INPUT_INVALID');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      admit();
      const read = await handle.read(bytes, count, bytes.length - count, count);
      admit();
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    admit();
    const after = await handle.stat({ bigint: true });
    admit();
    if (
      BigInt(count) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('PUBLIC_NATIVE_INPUT_CHANGED');
    result = bytes.subarray(0, count);
  } catch (value) {
    failure = { value };
  }
  try {
    await handle.close();
    retainedOriginalFiles.delete(handle);
  } catch (value) {
    failure ??= { value };
  }
  if (failure) throw failure.value;
  return result!;
}
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function readPublicNativeInput(
  path: string,
  admit: () => void = () => {}
): Promise<PublicNativeInput> {
  const input = PublicNativeInputSchema.parse(
    JSON.parse((await boundedOriginalFile(path, 16384, admit)).toString('utf8'))
  );
  admit();
  const home = await realpath(input.home);
  admit();
  // The preceding exclusive installer owns this temporary home; never use a personal installation.
  if (
    home !== input.home ||
    !home.includes(`${sep}T${sep}`) ||
    !home.split(sep).at(-1)?.startsWith('public-native-')
  )
    throw new Error('PUBLIC_NATIVE_EXCLUSIVE_HOME_REQUIRED');
  await verifyPublicNativeEmits(input, admit);
  return Object.freeze(input);
}
export async function verifyPublicNativeEmits(
  input: PublicNativeInput,
  admit: () => void = () => {}
): Promise<void> {
  const guardBytes = await boundedOriginalFile(input.emittedGuard, 1024 * 1024, admit);
  if (sha256(guardBytes) !== input.emittedGuardSHA256)
    throw new Error('PUBLIC_NATIVE_EMITS_CHANGED');
  const guard = z
    .object({ files: z.record(z.string(), digest) })
    .strict()
    .parse(JSON.parse(guardBytes.toString('utf8')));
  if (Object.keys(guard.files).length < 4 || guard.files[input.cliEntry] !== input.cliSHA256)
    throw new Error('PUBLIC_NATIVE_OWN_BUILD_REQUIRED');
  for (const [path, expected] of Object.entries(guard.files)) {
    if (
      !isAbsolute(path) ||
      sha256(await boundedOriginalFile(path, 32 * 1024 * 1024, admit)) !== expected
    )
      throw new Error('PUBLIC_NATIVE_EMITS_CHANGED');
  }
}
