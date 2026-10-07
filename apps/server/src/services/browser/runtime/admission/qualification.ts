import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createPrivateBrowserQualification } from './accepted-mode.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Explicit original parent grant, separate from observation hello/ready. No acceptance claim. */
export const OriginalBrowserQualificationSchema = z.strictObject({
  home: z.string().max(4096).refine(isAbsolute),
  cliSHA256: digest,
  executableSHA256: digest,
  mode: z.enum(['native', 'chrome-compatible']),
});
export type OriginalBrowserQualification = Readonly<
  z.infer<typeof OriginalBrowserQualificationSchema>
>;
/** Join the exact opened executable bytes before granting isolated fixture admission. */
export async function qualifyOriginalBrowserProcess(
  raw: OriginalBrowserQualification,
  home: string,
  entry: string,
  current: () => void,
  productionSubject?: () => Promise<string>
) {
  const grant = Object.freeze(OriginalBrowserQualificationSchema.parse(raw));
  current();
  if (
    (await realpath(home)) !== home ||
    home !== grant.home ||
    !home.includes('/T/') ||
    !home.split('/').at(-1)?.startsWith('public-native-') ||
    !isAbsolute(entry)
  )
    throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REFUSED');
  const original = await open(
    entry,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let first: { value: unknown } | undefined;
  try {
    current();
    const before = await original.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > 32n * 1024n * 1024n)
      throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REFUSED');
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      current();
      const result = await original.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    const after = await original.stat({ bigint: true });
    current();
    if (
      BigInt(count) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== grant.cliSHA256
    )
      throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REFUSED');
  } catch (value) {
    first = { value };
  }
  try {
    await original.close();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
  current();
  return createPrivateBrowserQualification({
    ...(productionSubject ? { productionSubject } : {}),
    current: () => {
      current();
      return true;
    },
    check: (subject) =>
      subject.executableSHA256 === grant.executableSHA256 &&
      subject.mode === grant.mode &&
      subject.platform === process.platform &&
      subject.arch === process.arch &&
      subject.channel === 'cli',
  });
}
