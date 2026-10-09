import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
  resolveInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { DesktopQualificationSubjectSchema } from '@dorkos/shared/browser-desktop-qualification';
import { readOriginalBrowserRuntimeClass } from '../../../apps/server/src/services/browser/runtime/admission/runtime-class.js';

declare const __BROWSER_PRODUCTION_SUBJECT__: string;

/** Derive an unaccepted subject from this signed package and genuine original installation duties.
 * The owned temporary home is retained for independent process/installation receipt observation.
 * This executable cannot mint a qualification capability or populate the release catalogue. */
export async function emitOriginalDesktopQualificationSubject(
  mode: 'native' | 'chrome-compatible',
  output: string,
  signal: AbortSignal
): Promise<void> {
  let phase:
    | 'admission'
    | 'runtime-class'
    | 'home-acquisition'
    | 'home-announcement'
    | 'home-canonicalization'
    | 'package-configuration'
    | 'installation-construction'
    | 'installation'
    | 'verification'
    | 'inspection'
    | 'native-package'
    | 'subject-schema'
    | 'subject-publication' = 'admission';
  let acquiredHome: string | undefined;
  try {
    signal.throwIfAborted();
    if (
      (mode !== 'native' && mode !== 'chrome-compatible') ||
      !isAbsolute(output) ||
      output.length > 4096 ||
      process.env.ELECTRON_RUN_AS_NODE !== '1' ||
      process.env.DORKOS_BROWSER_DESKTOP_NODE_EXECUTABLE !== process.execPath ||
      typeof __BROWSER_PRODUCTION_SUBJECT__ === 'undefined' ||
      !/^[a-f0-9]{64}$/u.test(__BROWSER_PRODUCTION_SUBJECT__)
    )
      throw new Error('SIGNED_SUBJECT_ORIGINAL_PACKAGE_REQUIRED');
    phase = 'runtime-class';
    const runtimeClass = readOriginalBrowserRuntimeClass();
    if (
      runtimeClass.kind !== 'electron' ||
      runtimeClass.platform !== 'darwin' ||
      runtimeClass.arch !== 'arm64'
    )
      throw new Error('SIGNED_SUBJECT_ORIGINAL_ELECTRON_REQUIRED');
    phase = 'home-acquisition';
    acquiredHome = await mkdtemp(join(tmpdir(), 'dorkos-signed-subject-'));
    phase = 'home-announcement';
    const enter = {
      schemaVersion: 1,
      readiness: 'unaccepted',
      stage: 'home-acquired',
      home: acquiredHome,
    };
    const enterBytes = JSON.stringify(enter) + '\n';
    if (Buffer.byteLength(enterBytes) > 16384) throw new Error('SIGNED_SUBJECT_RECEIPT_BOUND');
    try {
      process.stderr.write('SIGNED_SUBJECT_ENTER ' + enterBytes);
    } catch {}
    await writeFile(output + '.enter.json', enterBytes, { flag: 'wx', mode: 0o600 });
    phase = 'home-canonicalization';
    const home = await realpath(acquiredHome);
    signal.throwIfAborted();
    phase = 'package-configuration';
    const configuration = await resolveInstalledRuntimeConfiguration(
      new URL('../server/server-entry.mjs', import.meta.url),
      home
    );
    signal.throwIfAborted();
    if (
      configuration.nodeRuntime !== 'electron-node' ||
      configuration.nodeExecutable !== process.execPath
    )
      throw new Error('SIGNED_SUBJECT_ORIGINAL_EXECUTABLE_REQUIRED');
    phase = 'installation-construction';
    const installation = createRuntimeInstallation(configuration);
    phase = 'installation';
    const installed = await installation.install({ signal });
    signal.throwIfAborted();
    if (installed.state !== 'verified-installed')
      throw new Error('SIGNED_SUBJECT_INSTALLATION_REFUSED');
    phase = 'verification';
    const verified = await installation.verifyExisting({ signal });
    signal.throwIfAborted();
    if (verified.state !== 'verified-reused')
      throw new Error('SIGNED_SUBJECT_VERIFICATION_REFUSED');
    phase = 'inspection';
    const inspected = await installation.inspectExisting({ signal });
    signal.throwIfAborted();
    if (
      inspected.state !== 'installed-files' ||
      inspected.installationId !== verified.installationId ||
      inspected.currentManifestDigest !== verified.currentManifestDigest ||
      inspected.executableSHA256 !== verified.executableSHA256 ||
      inspected.lastFreshVerifiedVersion !== verified.observedVersion ||
      inspected.platform !== verified.platform ||
      inspected.arch !== verified.arch ||
      verified.platform !== configuration.platform ||
      verified.arch !== configuration.arch
    )
      throw new Error('SIGNED_SUBJECT_CURRENT_INSTALLATION_CHANGED');
    phase = 'native-package';
    const journal = await resolveInstalledNativeJournal(configuration);
    signal.throwIfAborted();
    phase = 'subject-schema';
    const subject = DesktopQualificationSubjectSchema.parse({
      executableSHA256: verified.executableSHA256,
      version: verified.observedVersion,
      revision: '1243',
      libraryVersion: '1.63.0',
      platform: configuration.platform,
      arch: configuration.arch,
      channel: 'desktop',
      ...configuration.sourceVintage,
      nativeJournalSHA256: createHash('sha256')
        .update(
          JSON.stringify({
            artifactSHA256: journal.artifact.sha256,
            sourceVintage: configuration.sourceVintage,
          })
        )
        .digest('hex'),
      runtimeClass,
      productionSubjectSHA256: __BROWSER_PRODUCTION_SUBJECT__,
      mode,
      identityPolicyRevision: 1,
      networkPolicyRevision: 1,
    });
    phase = 'subject-publication';
    // Exclusive output only after all authentic public installation originals have returned.
    await writeFile(
      output,
      JSON.stringify({
        schemaVersion: 1,
        readiness: 'unaccepted',
        home,
        qualificationSubject: subject,
        installed,
        verified,
      }) + '\n',
      { flag: 'wx', mode: 0o600, signal }
    );
  } catch (value) {
    // Classification never serializes arbitrary failure text, credentials or capabilities.
    try {
      const failureKind =
        value === false
          ? 'false'
          : value === undefined
            ? 'undefined'
            : value === null
              ? 'null'
              : typeof value;
      const failure = {
        schemaVersion: 1,
        readiness: 'unaccepted',
        stage: phase,
        failureKind,
        home: acquiredHome ?? null,
      };
      const bytes = JSON.stringify(failure) + '\n';
      if (Buffer.byteLength(bytes) > 16384)
        throw new Error('SIGNED_SUBJECT_RECEIPT_BOUND', { cause: value });
      try {
        process.stderr.write('SIGNED_SUBJECT_FAILURE ' + bytes);
      } catch {}
      if (isAbsolute(output) && output.length <= 4096) {
        try {
          await writeFile(output + '.failure.json', bytes, { flag: 'wx', mode: 0o600 });
        } catch {}
      }
    } catch {}
    throw value;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || !['native', 'chrome-compatible'].includes(process.argv[2]!))
    throw new Error('SIGNED_SUBJECT_ARGUMENTS_REQUIRED');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('SIGNED_SUBJECT_PARENT_STOPPED'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  emitOriginalDesktopQualificationSubject(
    process.argv[2] as 'native' | 'chrome-compatible',
    process.argv[3]!,
    lifetime.signal
  )
    .then(
      () => {},
      () => {
        process.exitCode = 1;
      }
    )
    .finally(() => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    });
}
