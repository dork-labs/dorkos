import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  DesktopQualificationHelloSchema,
  readOriginalDesktopDigest,
  readOriginalDesktopFrame,
  writeOriginalDesktopFrame,
} from '@dorkos/shared/browser-desktop-qualification';
import { readOriginalSignedDesktopVerification, signedBundleTree } from './verification.js';

/** Issue only from completed original signing checks to the retained original Electron child pipe. */
export async function grantOriginalSignedDesktopQualification(
  child: ChildProcess,
  verified: unknown,
  home: string,
  signal: AbortSignal
): Promise<void> {
  const original = readOriginalSignedDesktopVerification(verified);
  const subject = original.artifact.qualificationSubject;
  if (!subject) throw new Error('SIGNED_DESKTOP_QUALIFICATION_SUBJECT_REQUIRED');
  const input = child.stdout,
    output = child.stdin;
  const check = () => {
    signal.throwIfAborted();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error('SIGNED_DESKTOP_ORIGINAL_PARENT_RETURNED');
  };
  check();
  if (!input || !output) throw new Error('SIGNED_DESKTOP_ORIGINAL_PARENT_PIPE_REQUIRED');
  const receiving = new AbortController();
  const abort = () => receiving.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const hello = readOriginalDesktopFrame(
    input,
    receiving.signal,
    'DORKOS_PRIVATE_DESKTOP_QUALIFICATION '
  );
  void hello.catch(() => {});
  let first: { value: unknown } | undefined;
  try {
    await writeOriginalDesktopFrame(output, { type: 'browser-desktop-qualification-request' });
  } catch (value) {
    first = { value };
  }
  // The original reader must be settled even if the original request write failed.
  let received: unknown;
  if (first) {
    receiving.abort(first.value);
    await Promise.allSettled([hello]);
    signal.removeEventListener('abort', abort);
    throw first.value;
  }
  try {
    received = await hello;
  } finally {
    signal.removeEventListener('abort', abort);
  }
  check();
  const observed = DesktopQualificationHelloSchema.parse(received);
  const entry = join(
    original.artifact.appPath,
    'Contents/Resources/app.asar.unpacked/dist/server/server-entry.mjs'
  );
  const desktopExecutableSHA256 = await readOriginalDesktopDigest(original.executable, check);
  const serverEntrySHA256 = await readOriginalDesktopDigest(entry, check);
  if (
    observed.home !== join(home, '.dork') ||
    observed.appPath !== original.artifact.appPath ||
    observed.desktopExecutableSHA256 !== desktopExecutableSHA256 ||
    observed.serverEntrySHA256 !== serverEntrySHA256 ||
    (await signedBundleTree(original.artifact.appPath)) !== original.artifact.treeSHA256
  )
    throw new Error('SIGNED_DESKTOP_QUALIFICATION_SCOPE_REFUSED');
  check();
  await writeOriginalDesktopFrame(output, {
    type: 'browser-desktop-qualification-grant',
    nonce: observed.nonce,
    grant: {
      home: observed.home,
      appPath: observed.appPath,
      signedArtifactSHA256: original.artifact.treeSHA256,
      desktopExecutableSHA256,
      serverEntrySHA256,
      subject,
    },
  });
  check();
}
