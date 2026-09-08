/**
 * J-12, in-process half — two installs into one repo in the same tick (AP-10).
 *
 * The cross-PROCESS half of J-12 lives in the engine, where two child processes
 * apply real plans to one repo at once
 * (`packages/harness/src/__tests__/journeys/j12-two-writers.test.ts`). This is
 * the half that only exists in the server: `runAutoProjection` is fire-and-forget
 * from the install route, and it is not one synchronous act. It projects, AWAITS
 * a person's answer about a package's hooks, and projects again. Before
 * DOR-1854, a second install's whole projection could run inside that gap —
 * reading a tree the first install had half-approved, and writing the plan it
 * derived from it.
 *
 * Two things are asserted, and they are different claims:
 *
 * 1. **The runs take turns.** The timeline of seam calls and approval cards has
 *    the second install's projection AFTER the first install's second pass, not
 *    between its two passes.
 * 2. **The result is the sequential one.** The same two installs, awaited one
 *    after the other in a separately staged repo, leave a byte-identical tree.
 *
 * Nothing is mocked below the seam: the real `@dorkos/harness` plans and applies
 * over real temp directories, so what is compared is what lands on disk.
 *
 * **The seeded red.** With `withProjectLock` replaced by a pass-through, the
 * timeline came back with `project:beta` between the first install's two passes
 * — assertion 1 fails and names the interleaving. Assertion 2 stays green there,
 * which is the point of keeping them apart: convergence was already true, and
 * saying so is not the same as saying the runs did not overlap.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** A stateful config store: an approval recorded in one pass must be visible to the next. */
const config: {
  harness: { autoSync: boolean; approvedHooks: string[]; refusedHooks: string[] };
} = { harness: { autoSync: true, approvedHooks: [], refusedHooks: [] } };
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (config as Record<string, unknown>)[key],
    set: (key: string, value: unknown) => {
      (config as Record<string, unknown>)[key] = value;
    },
  },
}));

import { runAutoProjection, _internal as autoInternal } from '../auto-project.js';
import { _internal as approvalInternal, HOOK_PROJECTION_CAPABILITY_ID } from '../hook-approval.js';
import { projectWithConsent } from '../project-with-consent.js';
import type { HookApprovalGateway } from '../hook-approval.js';

/** The two packages installed into the same repo. */
const PACKAGES = ['alpha', 'beta'] as const;

const temps: string[] = [];

/** The shipped poll interval, restored after a test speeds it up. */
const DEFAULT_POLL_MS = approvalInternal.pollIntervalMs;

/** A fresh temp directory that is cleaned up after the test. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Stage a repo that syncs to Claude Code and Codex, with both plugins already
 * unpacked into `.dork/plugins` — the on-disk state two back-to-back installs
 * leave behind before auto-projection runs.
 */
function stageRepo(): string {
  const repo = makeTempDir('j12-repo-');
  mkdirSync(join(repo, '.agents'), { recursive: true });
  writeFileSync(
    join(repo, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)}\n`
  );
  for (const name of PACKAGES) {
    const plugin = join(repo, '.dork', 'plugins', name);
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name,
          version: '1.0.0',
          type: 'plugin',
          description: `the ${name} plugin`,
          layers: ['skills', 'hooks'],
        },
        null,
        2
      )}\n`
    );
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
    writeFileSync(
      join(plugin, 'hooks', 'hooks.json'),
      `${JSON.stringify({
        Stop: [{ hooks: [{ type: 'command', command: `echo ${name}` }] }],
      })}\n`
    );
    mkdirSync(join(plugin, 'skills', `${name}-helper`), { recursive: true });
    writeFileSync(
      join(plugin, 'skills', `${name}-helper`, 'SKILL.md'),
      `---\nname: ${name}-helper\ndescription: helps with ${name}\n---\n\n# ${name}\n`
    );
  }
  return repo;
}

/**
 * A content-hashed snapshot of a tree, with the repo's own absolute path
 * replaced by a placeholder.
 *
 * The normalisation is what lets two separately staged repos be compared: a
 * projected hook command names the plugin's install directory, which is
 * different in every temp dir and is not what this test is about.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const scrub = (text: string): string =>
    text.split(realpathSync(root)).join('<REPO>').split(root).join('<REPO>');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (entry.isDirectory()) {
        out[rel] = 'dir';
        walk(abs);
      } else {
        out[rel] = `sha:${createHash('sha256')
          .update(scrub(readFileSync(abs, 'utf8')))
          .digest('hex')}`;
      }
    }
  };
  walk(root);
  return out;
}

/**
 * An approval gateway that says yes — but only on the SECOND presentation of a
 * token, so the wait between a projection's two passes is a real macrotask that
 * anything unserialized has every chance to run inside.
 *
 * @param timeline - the shared timeline; each card raised is recorded on it.
 */
function grantingGateway(timeline: string[]): HookApprovalGateway {
  let issued = 0;
  const presented = new Map<string, number>();
  return {
    request: (input) => {
      const name = PACKAGES.find((p) => input.summary.includes(p)) ?? 'unknown';
      timeline.push(`ask:${name}`);
      const token = `token-${++issued}`;
      return {
        approvalId: `approval-${issued}`,
        token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
    consume: (token) => {
      const seen = (presented.get(token) ?? 0) + 1;
      presented.set(token, seen);
      return seen === 1
        ? {
            outcome: 'pending' as const,
            approvalId: token,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }
        : {
            outcome: 'granted' as const,
            approvalId: token,
            capabilityId: HOOK_PROJECTION_CAPABILITY_ID,
          };
    },
  };
}

/**
 * Record every seam call on the timeline, tagged with which install made it.
 *
 * The tag rides on `dorkHome`, which is an empty temp directory in this test and
 * so changes nothing the engine writes: it is the only per-call value the seam
 * receives that this test can vary, and it beats reading run identity back out
 * of a log line.
 */
function recordSeamCalls(timeline: string[], homes: Record<string, string>): void {
  vi.spyOn(autoInternal, 'projectWithConsent').mockImplementation((projectPath, opts) => {
    const name = PACKAGES.find((p) => homes[p] === opts.dorkHome) ?? 'unknown';
    timeline.push(`project:${name}`);
    return projectWithConsent(projectPath, opts);
  });
}

describe('J-12 — two installs into one repo, in one process', () => {
  let homes: Record<string, string>;

  beforeEach(() => {
    vi.restoreAllMocks();
    config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
    approvalInternal.pollIntervalMs = 0;
    approvalInternal.forgetDecisions();
    homes = { alpha: makeTempDir('j12-home-a-'), beta: makeTempDir('j12-home-b-') };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    approvalInternal.pollIntervalMs = DEFAULT_POLL_MS;
    approvalInternal.forgetDecisions();
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('J-12, AP-10: takes turns: the second install projects after the first has finished, not inside it', async () => {
    const repo = stageRepo();
    const timeline: string[] = [];
    recordSeamCalls(timeline, homes);
    const approvals = grantingGateway(timeline);

    await Promise.all(
      PACKAGES.map((packageName) =>
        runAutoProjection(
          { projectPath: repo, packageName, action: 'install' },
          { dorkHome: homes[packageName]!, approvals }
        )
      )
    );

    // alpha's first pass withholds both packages' hooks and raises both cards
    // (they are both already on disk); its second pass installs them; only THEN
    // does beta project, and it finds nothing left to ask about.
    expect(timeline).toEqual([
      'project:alpha',
      'ask:alpha',
      'ask:beta',
      'project:alpha',
      'project:beta',
    ]);
  });

  it('J-12, AP-10: leaves exactly the tree the same two installs leave one after the other', async () => {
    const concurrentRepo = stageRepo();
    const approvals = grantingGateway([]);
    await Promise.all(
      PACKAGES.map((packageName) =>
        runAutoProjection(
          { projectPath: concurrentRepo, packageName, action: 'install' },
          { dorkHome: homes[packageName]!, approvals }
        )
      )
    );

    // A second repo, staged identically, projected strictly one after the other.
    config.harness = { autoSync: true, approvedHooks: [], refusedHooks: [] };
    approvalInternal.forgetDecisions();
    const sequentialRepo = stageRepo();
    const sequentialApprovals = grantingGateway([]);
    for (const packageName of PACKAGES) {
      await runAutoProjection(
        { projectPath: sequentialRepo, packageName, action: 'install' },
        { dorkHome: homes[packageName]!, approvals: sequentialApprovals }
      );
    }

    const concurrent = snapshot(concurrentRepo);
    expect(concurrent).toEqual(snapshot(sequentialRepo));
    // …and the tree is the projected one, not two empty repos matching.
    expect(Object.keys(concurrent)).toEqual(
      expect.arrayContaining([
        '.codex/hooks.json',
        '.codex/hooks.json.dorkos-generated',
        '.claude/settings.local.json',
        '.claude/skills/alpha__alpha-helper',
        '.claude/skills/beta__beta-helper',
      ])
    );
    expect(
      lstatSync(join(concurrentRepo, '.claude/skills/alpha__alpha-helper')).isSymbolicLink()
    ).toBe(true);
  });
});
