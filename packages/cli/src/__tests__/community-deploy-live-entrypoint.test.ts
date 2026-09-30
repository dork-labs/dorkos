import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function run(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stderr: string }>((resolvePromise, reject) => {
    const child = execFile(executable, args, { env: environment }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolvePromise({ code: typeof error?.code === 'number' ? error.code : 0, stderr });
    });
    child.once('error', reject);
  });
}

describe('credentialed live gate entrypoint', () => {
  it('refuses before npm, a profile, or any provider boundary when arms are absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dorkos-live-entrypoint-'));
    directories.push(directory);
    const marker = join(directory, 'npm-was-called');
    const npm = join(directory, 'npm');
    await writeFile(
      npm,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`,
      { mode: 0o700 }
    );
    await chmod(npm, 0o700);
    const script = resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts');
    const tsx = resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
    const result = await run(process.execPath, [tsx, script], {
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      HOME: directory,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Community live gate is not armed');
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The capture socket is opened mid-run and was closed only where the run
  // succeeded, so every throw after it opened leaked a listening server for the
  // life of the process. A real run needs both arms and a paid provider, so the
  // cheap guard is the shape of the code: opened into a binding declared
  // outside the try, and closed in the finally that already wipes the secret.
  it('closes the capture socket on every path out of the run', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const opens = [...source.matchAll(/await receiveClipboard\(/gu)];
    expect(opens).toHaveLength(1);
    expect(source).toMatch(/let clipboard: Awaited<ReturnType<typeof receiveClipboard>> \| null/u);
    expect(source).toMatch(/\(clipboard = await receiveClipboard\(/u);
    const finallyBlock = source.slice(source.lastIndexOf('} finally {'));
    expect(finallyBlock).toMatch(/await clipboard\?\.close\(\)/u);
    // The same holds for the launcher's PTY: a failed owner proof must not leave it waiting on a
    // prompt for the rest of its twelve-minute timeout.
    expect(source).toMatch(/let launcher: LauncherRun \| null/u);
    expect(finallyBlock).toMatch(/launcher\?\.kill\(\)/u);
  });

  // The launcher asks for Tigris terms only after it has created the Fly app and the Neon project.
  // The decisions themselves are unit-tested beside the responder; this pins where main makes
  // them, since a real run is the only other way to see the order and it costs money.
  it('checks Tigris terms and heals the PTY helper before the launcher can write', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const firstLaunch = main.indexOf('runLauncherPty({');
    expect(firstLaunch).toBeGreaterThan(0);
    const termsCheck = main.indexOf('await requireTigrisTermsAccepted(');
    expect(termsCheck).toBeGreaterThan(0);
    expect(termsCheck).toBeLessThan(firstLaunch);
    const heal = main.indexOf(
      'ensureNodePtySpawnHelperExecutable({ resolveFrom: import.meta.url })'
    );
    expect(heal).toBeGreaterThan(0);
    expect(heal).toBeLessThan(firstLaunch);
    // A refusal from the responder must stop the launcher, not merely fail the gate's promise.
    expect(source).toMatch(
      /action\.type === 'refuse'\) \{[^}]*reject\(new CommunityLiveGateError\(action\.step\)\);\s*terminal\.kill\(\);/u
    );
  });

  // The decisions are unit-tested beside their modules; a real run costs money, so this pins
  // where main makes them. A failure after cleanup must not print a recovery command for resources
  // already deleted, and a resumed launcher that exits cleanly must not hold the run for the whole
  // twelve-minute capture timeout.
  it('marks cleanup finished before its last reads, and bounds the second secret by the launcher', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const cleanup = main.indexOf('await cleanupCommunityLiveGate(');
    const cleanedUp = main.indexOf('cleanedUp = true;');
    const afterRead = main.indexOf('const after = {');
    expect(cleanup).toBeGreaterThan(0);
    expect(cleanedUp).toBeGreaterThan(cleanup);
    expect(cleanedUp).toBeLessThan(afterRead);
    // A storage bucket bills too (DOR-2584 review): it is re-read after cleanup, while the Fly
    // session is still held, and before cleanup is called finished, so a bucket that survived
    // fails the gate with the recovery command still printed; the receipt records the answer.
    const tigrisRecheck = main.indexOf('tigrisBucketFound = await tigris(');
    expect(tigrisRecheck).toBeGreaterThan(cleanup);
    expect(tigrisRecheck).toBeLessThan(main.indexOf('credential.dispose();', cleanup));
    expect(tigrisRecheck).toBeLessThan(cleanedUp);
    expect(main.slice(afterRead, afterRead + 400)).toContain('tigrisBucketFound,');
    expect(main).toMatch(
      /catch \(error\) \{\s*throw await explainCommunityLiveGateFailure\(\s*error,\s*\{ cleanedUp, recoveryCommand \}/u
    );
    // A launcher that exits with a failure is reported with the code it saved in its journal.
    expect(main).toMatch(/return describeLauncherStop\(JSON\.parse\(journal\) as unknown\);/u);
    expect(source).toMatch(/process\.stderr\.write\(describeCommunityLiveGateFailure\(error\)\)/u);
    expect(main).toMatch(
      /bootstrap = await whileLauncherRuns\(resumed, capture\.next\(TIMEOUT_MS\), \{\s*ms: DELIVERED_CAPTURE_MS,\s*step: 'bootstrap-capture-after-launcher-exit',\s*\}\)/u
    );
  });

  // An unreleased run must copy its tarball into the retained run directory and check the copy
  // before any npm, profile or service call, then install and recover from that copy only. A real
  // run costs money, so this pins the order in main; the check itself is unit-tested beside it.
  it('checks an unreleased tarball first, installs that file, and records it as not a release', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const inspect = main.indexOf(
      "tarball = await inspectCommunityLiveTarball(\n        config.source.path,\n        join(durableHome, 'package-under-test')\n      );"
    );
    expect(inspect).toBeGreaterThan(0);
    expect(inspect).toBeLessThan(main.indexOf('await command('));
    expect(inspect).toBeLessThan(main.indexOf('readFlySessionCredential('));
    expect(main).toMatch(/if \(!tarball\) \{\s*const published = parsePublishedVersion\(/u);
    // Installed and recovered from the verified copy the check returned, never the original path.
    expect(main).toContain('tarball ? tarball.path : `dorkos@${version}`');
    expect(main).not.toMatch(/config\.source\.path(?![\s\S]{0,80}package-under-test)/u);
    expect(main).toMatch(/JSON\.stringify\(\{\s*version,\s*source,/u);
    const recovery = main.slice(main.indexOf('communityLiveGateRecoveryCommand('));
    expect(recovery.slice(0, recovery.indexOf(';'))).toContain('tarball?.path');
  });

  // A launcher that exits before writing a launch record leaves no journal, so its own last code is
  // the only explanation (DOR-2169). A real run costs money, so this pins the wiring; the reading
  // itself is unit-tested in community-deploy-live-failure.test.ts.
  it('attaches the launcher last error code when it exits with a failure', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const onExit = source.slice(source.indexOf('terminal.onExit('));
    expect(onExit.slice(0, onExit.indexOf('});'))).toMatch(
      /new CommunityLiveGateError\(\s*PUBLISHED_LAUNCHER_STEP,\s*null,\s*describeLauncherExit\(transcript\) \?\? undefined\s*\)/u
    );
  });

  // The pack recipe must refuse a checkout past its release's migrations before it spends minutes
  // building a launcher that could never deploy.
  it('checks the Community migrations against the release tag before building', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/pack-community-live-tarball.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const guard = main.indexOf('assertReleasedCommunityMigrations(git, packedVersion);');
    expect(guard).toBeGreaterThan(main.indexOf("requireClean('before packing');"));
    expect(guard).toBeLessThan(main.indexOf("['--filter', 'dorkos', 'build']"));
    expect(guard).toBeLessThan(main.indexOf('createCommunityLivePackDirectory('));
  });

  // The provenance receipt (DOR-2238 phase 2) is only worth anything if it reads the resources
  // before cleanup deletes them. A real run costs money, so this pins the order in main; the probes
  // themselves are unit-tested beside them.
  it('records the provenance receipt before cleanup, with every probe inside the guard', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    // Whitespace-tolerant: the block moved into the held phase's cleanup callback (DOR-2591).
    const probes = main.search(
      /provenance = await guardCommunityLiveProvenance\(\(\) =>\s+probeCommunityLiveProvenance\(journal, \{/u
    );
    const cleanup = main.indexOf('await cleanupCommunityLiveGate(');
    expect(probes).toBeGreaterThan(0);
    expect(probes).toBeLessThan(cleanup);
    expect(main).toMatch(/\n\s+provenance,\n/u);
    expect(main).toContain("args: ['ssh', 'console', '--app', name, '--command', 'true']");
    // Every probe call, including the unknown-app name, runs inside the guard's callback.
    const guarded = main.slice(probes, cleanup);
    expect(guarded).toContain('unknownAppName: () =>');
    expect(main.slice(0, probes)).not.toContain('probeCommunityLiveProvenance(');
    expect(main.slice(0, probes)).not.toContain('unknownAppName');
    // Nothing in Fly's API reads a private network once its app is gone, so no step claims to.
    expect(main).not.toContain('NetworkAfterCleanup');
  });

  // The hold (DOR-2591) runs after provider resources exist, so what matters is where main puts
  // it: the second-member proof and the hold inside the held phase, and the whole existing cleanup
  // inside that phase's cleanup callback, so no way out of the phase can skip it. The phase itself
  // is unit-tested in community-deploy-live-hold.test.ts; a real run costs money.
  it('runs the second-member proof and the hold inside the held phase, before cleanup', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const phase = main.indexOf('await runHeldPhaseThenCleanUp({');
    const phaseCallback = main.indexOf('phase: async (signal) => {', phase);
    const cleanupCallback = main.indexOf('cleanup: async () => {', phase);
    expect(phase).toBeGreaterThan(main.indexOf('bootstrap-rotation'));
    expect(phaseCallback).toBeGreaterThan(phase);
    expect(cleanupCallback).toBeGreaterThan(phaseCallback);
    const wiring = main.slice(phase, phaseCallback);
    expect(wiring).toContain('signals: process,');
    // Output errors after the terminal closes must not crash cleanup (DOR-2591 review).
    expect(wiring).toContain('streams: [process.stdout, process.stderr],');
    expect(wiring).toContain('write: quietWriter(process.stderr),');
    const heldPhase = main.slice(phaseCallback, cleanupCallback);
    expect(heldPhase).toContain('await runCommunityLiveSecondMemberProof(ownerProof.owner, {');
    expect(heldPhase).toContain('await holdCommunityLive({');
    expect(heldPhase).toContain('signal,');
    expect(heldPhase).toContain('write: quietWriter(process.stdout),');
    // Every provider read and write of cleanup, and the point it is called finished, are inside
    // the cleanup callback, never before the phase.
    for (const step of [
      'readFlySessionCredential(fly);\n        const tigris',
      'await cleanupCommunityLiveGate(',
      'tigrisBucketFound = await tigris(',
      'cleanedUp = true;',
    ]) {
      expect(main.indexOf(step)).toBeGreaterThan(cleanupCallback);
    }
    expect(main.slice(0, phase)).not.toContain('await cleanupCommunityLiveGate(');
  });

  // The handoff holds two passwords and the invitation. Only the hold may see them: the receipt
  // takes the proofs' own receipt objects, and nothing else of theirs.
  it('keeps the handoff access and the owner session out of the receipt', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    expect([...main.matchAll(/\.access\b/gu)].map((match) => match[0])).toEqual(['.access']);
    expect(main).toContain('access: member.access,');
    const receipt = main.slice(main.indexOf('await writeFile(\n      receiptPath,'));
    const body = receipt.slice(0, receipt.indexOf("+ '\\n'"));
    expect(body).toContain('...ownerProof.receipt,');
    expect(body).toContain('...held.phase.member,');
    expect(body).toMatch(/\.\.\.\(held\.phase\.hold \? \{ held: held\.phase\.hold \} : \{\}\)/u);
    expect(body).not.toMatch(
      /\baccess\b|ownerProof\.owner|ownerProof,|\.\.\.ownerProof\b(?!\.receipt)/u
    );
    // The phase returns only the member's receipt and the hold's record.
    expect(main).toContain('return { member: member.receipt, hold };');
  });

  // The handoff must never land in this checkout, where it could be committed. A misplaced
  // DORK_HOME is refused before anything is created.
  it('refuses a hold whose retained directory is inside the repository, before any process', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../../scripts/test-community-deploy-live.ts'),
      'utf8'
    );
    const main = source.slice(source.indexOf('async function main()'));
    const refusal = main.indexOf(
      "throw new CommunityLiveGateError('hold-directory-inside-repository');"
    );
    // Real paths, not path text: a symlinked DORK_HOME must not slip past (DOR-2591 review). The
    // comparison itself is tested in community-deploy-live-hold.test.ts.
    const check = main.indexOf('await isWithinDirectory(liveGateHome,');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(refusal);
    expect(main).not.toMatch(/relative\(/u);
    expect(refusal).toBeGreaterThan(main.indexOf('parseCommunityLiveGateConfig(process.env)'));
    expect(refusal).toBeLessThan(main.indexOf('await mkdtemp('));
    expect(refusal).toBeLessThan(main.indexOf('await command('));
  });
});
