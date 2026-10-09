import { DesktopQualificationSubjectSchema } from '@dorkos/shared/browser-desktop-qualification';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { readOriginalSignedDesktopVerification } from '../signed-desktop/verification.js';
import { grantOriginalSignedDesktopQualification } from '../signed-desktop/qualification.js';
import { ChildProcess } from 'node:child_process';

describe('signed original parent qualification', () => {
  it('refuses copied verification before any copied executable getter or child pipe access', async () => {
    let reads = 0;
    const copied = {
      get executable() {
        reads++;
        throw false;
      },
    };
    expect(() => readOriginalSignedDesktopVerification(copied)).toThrow(
      'SIGNED_DESKTOP_ORIGINAL_VERIFICATION_REQUIRED'
    );
    // No child/process needs to be acquired merely to reject a copied capability.
    const original = new ChildProcess();
    await expect(
      grantOriginalSignedDesktopQualification(
        original,
        copied,
        '/unowned',
        new AbortController().signal
      )
    ).rejects.toThrow('SIGNED_DESKTOP_ORIGINAL_VERIFICATION_REQUIRED');
    expect(reads).toBe(0);
  });
});

describe('signed descriptor nested custody', () => {
  it('captures nested metadata before simulated signing duties and retains immutable verified scope', async () => {
    const digest = 'a'.repeat(64);
    const subject = DesktopQualificationSubjectSchema.parse({
      runtimeClass: {
        kind: 'electron',
        nodeVersion: '24.14.1',
        modulesABI: '137',
        v8Version: '13.6.233.10',
        opensslVersion: '3.5.2',
        uvVersion: '1.51.0',
        electronVersion: '40.0.0',
        platform: 'darwin',
        arch: 'arm64',
        featureContract: 'browser-owner-runtime-v1',
        surface: {
          abortSignalAny: true,
          abortSignalTimeout: true,
          workerThreads: true,
          callbackDnsCancel: true,
          bigint: true,
        },
      },
      executableSHA256: digest,
      version: '153',
      revision: '1243',
      libraryVersion: '1.63.0',
      platform: 'darwin',
      arch: 'arm64',
      channel: 'desktop',
      sourceManifestSHA256: digest,
      controllerSHA256: digest,
      verifierSHA256: digest,
      nativeJournalSHA256: digest,
      productionSubjectSHA256: digest,
      mode: 'chrome-compatible',
      identityPolicyRevision: 1,
      networkPolicyRevision: 1,
    });
    const bytes = Buffer.from('owned observer');
    const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const supplied = {
      appPath: '/Owned.app',
      treeSHA256: sha('[]'),
      teamIdentifier: 'ABCDEFGHIJ',
      bundleIdentifier: 'ai.dork.owned',
      version: '1.0.0',
      observerSHA256: sha(bytes),
      qualificationSubject: subject,
    };
    let tools = 0;
    vi.doMock('node:fs/promises', () => ({
      realpath: async (path: string) => path,
      readdir: async () => [],
      lstat: async (path: string) => ({
        isSymbolicLink: () => false,
        isDirectory: () => path === '/Owned.app',
        isFile: () => path !== '/Owned.app',
      }),
      readFile: async () => bytes,
    }));
    vi.doMock('node:child_process', () => ({
      spawn: (executable: string, argv: string[]) => {
        tools++;
        // Mutation while original verification is awaiting cannot change the captured vintage.
        supplied.qualificationSubject.runtimeClass.nodeVersion = '99.0.0';
        const stdout = new PassThrough(),
          stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          stdout,
          stderr,
          pid: tools,
          exitCode: 0,
          signalCode: null,
          kill() {},
        });
        queueMicrotask(() => {
          const output =
            executable === '/usr/bin/codesign' && argv[0] === '--display'
              ? 'Authority=Developer ID Application: Owned\nTeamIdentifier=ABCDEFGHIJ\nIdentifier=ai.dork.owned\n'
              : executable === '/usr/sbin/spctl'
                ? 'source=Notarized Developer ID'
                : argv.includes('Print :CFBundleExecutable')
                  ? 'Owned'
                  : argv.includes('Print :CFBundleShortVersionString')
                    ? '1.0.0'
                    : '';
          stdout.once('end', () => stdout.destroy());
          stderr.once('end', () => stderr.destroy());
          stdout.end(output);
          stderr.end();
          Promise.all([
            new Promise<void>((yes) => stdout.once('close', yes)),
            new Promise<void>((yes) => stderr.once('close', yes)),
          ]).then(() => child.emit('close', 0, null));
        });
        return child;
      },
    }));
    vi.resetModules();
    try {
      const owner = await import('../signed-desktop/verification.js');
      const parsed = owner.parseSignedDesktopArtifact(supplied);
      if (!parsed.qualificationSubject) throw new Error('PARSED_SUBJECT_REQUIRED');
      expect(parsed.qualificationSubject.runtimeClass).not.toBe(subject.runtimeClass);
      expect(Reflect.set(parsed.qualificationSubject.runtimeClass, 'nodeVersion', '98.0.0')).toBe(
        false
      );
      expect(Reflect.set(parsed.qualificationSubject.runtimeClass.surface, 'bigint', false)).toBe(
        false
      );
      const verified = await owner.verifySignedDesktop(supplied, {}, new AbortController().signal);
      const retained = owner.readOriginalSignedDesktopVerification(verified).artifact;
      expect(tools).toBe(6);
      if (!retained.qualificationSubject) throw new Error('RETAINED_SUBJECT_REQUIRED');
      supplied.qualificationSubject.runtimeClass.nodeVersion = '100.0.0';
      expect(retained.qualificationSubject?.runtimeClass.nodeVersion).toBe('24.14.1');
      expect(Reflect.set(retained.qualificationSubject.runtimeClass, 'nodeVersion', '97.0.0')).toBe(
        false
      );
      expect(Reflect.set(retained.qualificationSubject.runtimeClass.surface, 'bigint', false)).toBe(
        false
      );
      expect(retained.qualificationSubject?.runtimeClass.surface.bigint).toBe(true);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});
