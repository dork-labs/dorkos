/**
 * Replay suite for `check-copy-spec-drift.ts` — the incidents themselves.
 *
 * SPLIT FROM `check-copy-spec-drift.test.ts` (DOR-1819), which holds the unit
 * rules: what counts as copy, how a regex literal is read, which run contains
 * which, and when a HEAD run is allowed to say "that still renders". This file
 * holds the other half — the three real queue ejections replayed end to end,
 * because those are what the thresholds next door were calibrated against.
 *
 * THE REGRESSIONS ARE FIXTURES, NOT PROSE. `catches the real 2026-08-31
 * regressions` reproduces #1397's actual shapes — the interpolated
 * `Compacted context — ${pre} → ${post} tokens` in a bare `return`, and the
 * `Connected — ${n} tool…` template whose spec asserts a REGEX — because those
 * two are what the design was first calibrated against.
 *
 * AND SO IS #1549. The gate reported CLEAN on all four browser assertions that
 * batch stranded, which then ejected it from the merge queue — the gate's own
 * failure class, reproduced against the fix for it. `catches the four PR #1549
 * breaks` reproduces each of the three measured causes as its own case, in the
 * shapes the real files held, plus the two shapes that must stay quiet.
 *
 * The last suite runs the real script against a real throwaway git repository:
 * a base commit, a copy rewrite committed on top, and `runCopySpecGuard` doing
 * its own `git diff`/`git show`. The classification tests next door would all
 * still pass if the git plumbing addressed the wrong side of the diff, so the
 * plumbing is executed rather than mocked.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collapseByPosition,
  dropSupported,
  extractChunks,
  matchSpecStrings,
  removedChunks,
  runCopySpecGuard,
  type Chunk,
} from '../check-copy-spec-drift.ts';

const tempDirs: string[] = [];

/** A fresh temp directory, tracked for cleanup after the test. */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copy-spec-drift-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Chunk texts only, for assertions that do not care about position. */
function texts(chunks: Chunk[]): string[] {
  return chunks.map((chunk) => chunk.text);
}

// ---------------------------------------------------------------------------
// The two failures this gate was built for
// ---------------------------------------------------------------------------

/**
 * Run the pure pipeline the way `runCopySpecGuard` composes it, over one
 * component file and one spec file.
 *
 * @param before - The component at the base commit.
 * @param after - The component at HEAD.
 * @param spec - The apps/e2e file, read with regex harvesting on.
 * @param corpus - Extra HEAD copy from files this change did NOT touch.
 */
function guard(before: string, after: string, spec: string, corpus: string[] = []): number {
  const COMPONENT = 'apps/client/src/Card.tsx';
  const afterChunks = extractChunks(COMPONENT, after);
  const removed = removedChunks(extractChunks(COMPONENT, before), afterChunks);
  const matched = matchSpecStrings(
    removed,
    extractChunks('apps/e2e/tests/x.spec.ts', spec, { includeRegex: true })
  );
  return collapseByPosition(dropSupported(matched, [...texts(afterChunks), ...corpus], afterChunks))
    .length;
}

describe('catches the real 2026-08-31 regressions', () => {
  it('catches #1397 breaking compaction.ts (interpolated copy, string assertion)', () => {
    expect(
      guard(
        'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}',
        'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}',
        "await expect(liveRow).toContainText('Compacted context — 51.2k → 4.2k tokens');"
      )
    ).toBe(1);
  });

  it('catches #1397 breaking mcp-oauth-signin.spec.ts (regex assertion)', () => {
    expect(
      guard(
        'export function label(n: number) {\n  return `Connected — ${n} tool${n === 1 ? "" : "s"}.`;\n}',
        'export function label(n: number) {\n  return `Connected · ${n} tool${n === 1 ? "" : "s"}.`;\n}',
        'await expect(section.getByText(/Connected — 2 tools\\./)).toBeVisible();',
        // The unrelated component that kept `Connected —` alive through the
        // sweep. A corpus-wide presence test would suppress on this; the
        // more-specific rule must not.
        ['Connected —']
      )
    ).toBe(1);
  });

  it('stays quiet once the spec is updated in the same change', () => {
    expect(
      guard(
        'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}',
        'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}',
        "await expect(liveRow).toContainText('Compacted context · 51.2k → 4.2k tokens');"
      )
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The gate's own failure class, reproduced (DOR-1819)
// ---------------------------------------------------------------------------

describe('catches the four PR #1549 breaks', () => {
  it('catches the chip, whose spec string is SHORTER than the removed run', () => {
    // `AgentListItem.tsx`. The template's static run carries a trailing ` for`
    // that the regex stops before, so one-directional containment — "does the
    // spec string contain the removed chunk" — never fired.
    expect(
      guard(
        'export const label = (n: number, who: string) =>\n  `${n} live sessions — open the session switcher for ${who}`;',
        'export const label = (n: number, who: string) =>\n  `${n} live sessions, open the session switcher for ${who}`;',
        "const chip = page.getByRole('button', { name: /live sessions — open the session switcher/ });"
      )
    ).toBe(1);
  });

  it('catches the settings row, asserted by a case-insensitive ANCHORED regex', () => {
    // `ServerTab.tsx`. `^` and the `i` flag between them made the whole
    // assertion invisible: the caret never appears in the component's string,
    // and the folded casing meant a verbatim comparison could not match either.
    expect(
      guard(
        'export const Row = () => <ConfigRow label="Working Directory" value={cwd} />;',
        'export const Row = () => <ConfigRow label="Working folder" value={cwd} />;',
        "await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();"
      )
    ).toBe(1);
  });

  it('catches the presence line a longer UNCHANGED constant beside it was vouching for', () => {
    // `presence-copy.ts`. `TAKING_LONGER` did not change, is longer than the
    // run that vanished, and is of course inside the spec's sentence — so the
    // old suppression rule read it as "the copy still renders".
    expect(
      guard(
        "const TAKING_LONGER = 'this is taking longer than usual';\nexport const line = (who: string) => `${who} is still working — ${TAKING_LONGER}`;",
        "const TAKING_LONGER = 'this is taking longer than usual';\nexport const line = (who: string) => `${who} is still working, ${TAKING_LONGER}`;",
        'await expect(roomsPage.presenceLine).toHaveText(`${ana.name} is still working — this is taking longer than usual · 12m`);'
      )
    ).toBe(1);
  });

  it('stays quiet on the Title-Case sweep a case-insensitive locator survives', () => {
    // The other half of the same batch, and the reason the copy side is
    // classified first: `/new session/i` goes on matching `New session`, so a
    // casing-only rewrite must report nothing.
    expect(
      guard(
        "export const action = { label: 'New Session', run };",
        "export const action = { label: 'New session', run };",
        "const item = page.getByRole('option', { name: /new session/i });"
      )
    ).toBe(0);
  });

  it('stays quiet on a short spec string that merely sits inside a longer removed run', () => {
    expect(
      guard(
        "export const tools = { messaging: 'Send messages and check the inbox' };",
        "export const tools = { messaging: 'Let agents send messages and check the inbox.' };",
        "await expect(composer.getByRole('button', { name: 'Send message' })).toBeVisible();"
      )
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End to end, through real git
// ---------------------------------------------------------------------------

/** Write `contents` to `repo/relPath`, creating parent directories. */
function write(repo: string, relPath: string, contents: string): void {
  const absolute = join(repo, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** Run git in `repo` with hooks and signing disabled. */
function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8' }
  );
}

describe('runCopySpecGuard — through a real git checkout', () => {
  const COMPONENT = 'apps/client/src/CompactBoundaryRow.tsx';
  const SPEC = 'apps/e2e/tests/chat/compaction.spec.ts';

  /** A repo whose base commit renders and asserts the same copy. */
  function seedRepo(): { repo: string; base: string } {
    const repo = makeTempDir();
    git(repo, 'init', '-b', 'main');
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context — ${pre} → ${post} tokens`;\n}\n'
    );
    write(
      repo,
      SPEC,
      "test('shows the boundary', async () => {\n  await expect(row).toContainText('Compacted context — 51.2k → 4.2k tokens');\n});\n"
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    return { repo, base: git(repo, 'rev-parse', 'HEAD').trim() };
  }

  it('reds on a copy rewrite the browser suite still asserts', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );
    git(repo, 'commit', '-am', 'em-dash sweep');

    const findings = runCopySpecGuard(repo, base);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.specFile).toBe(SPEC);
    expect(findings[0]?.specLine).toBe(2);
    expect(findings[0]?.copyFile).toBe(COMPONENT);
    expect(findings[0]?.removed).toBe('Compacted context —');
  });

  it('stays green when the same change updates the spec', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );
    write(
      repo,
      SPEC,
      "test('shows the boundary', async () => {\n  await expect(row).toContainText('Compacted context · 51.2k → 4.2k tokens');\n});\n"
    );
    git(repo, 'commit', '-am', 'em-dash sweep, suite in step');

    expect(runCopySpecGuard(repo, base)).toEqual([]);
  });

  it('stays green when the change touches no copy root at all', () => {
    const { repo, base } = seedRepo();
    write(repo, 'docs/thing.mdx', 'Compacted context — some prose.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'docs only');

    expect(runCopySpecGuard(repo, base)).toEqual([]);
  });

  it('reports every stale assertion of a #1549-shaped batch, once each', () => {
    // All three causes in one change, through the real git plumbing, with the
    // e2e side left behind exactly as the batch left it. Five assertions, five
    // findings, no duplicates — the shape the real replay produces.
    const repo = makeTempDir();
    git(repo, 'init', '-b', 'main');
    write(
      repo,
      'apps/client/src/AgentListItem.tsx',
      'export const chipLabel = (n: number, who: string) =>\n  `${n} live sessions — open the session switcher for ${who}`;\n'
    );
    write(
      repo,
      'apps/client/src/ServerTab.tsx',
      'export const Row = () => <ConfigRow label="Working Directory" value={cwd} />;\n'
    );
    write(
      repo,
      'apps/client/src/presence-copy.ts',
      "const TAKING_LONGER = 'this is taking longer than usual';\n" +
        'export const line = (who: string) => `${who} is still working — ${TAKING_LONGER}`;\n'
    );
    write(
      repo,
      'apps/e2e/tests/session-switcher.spec.ts',
      "const chip = page.getByRole('button', { name: /live sessions — open the session switcher/ });\n" +
        "const again = page.getByRole('button', { name: /live sessions — open the session switcher/ });\n"
    );
    write(
      repo,
      'apps/e2e/tests/settings-dialog.spec.ts',
      "await expect(panel.getByRole('button', { name: /^working directory/i })).toBeVisible();\n"
    );
    write(
      repo,
      'apps/e2e/tests/room-presence.spec.ts',
      'await expect(line).toHaveText(`${ana.name} is still working — this is taking longer than usual · 12m`);\n' +
        'await expect(announcer).toHaveText(`${ana.name} is still working — this is taking longer than usual`);\n'
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();

    write(
      repo,
      'apps/client/src/AgentListItem.tsx',
      'export const chipLabel = (n: number, who: string) =>\n  `${n} live sessions, open the session switcher for ${who}`;\n'
    );
    write(
      repo,
      'apps/client/src/ServerTab.tsx',
      'export const Row = () => <ConfigRow label="Working folder" value={cwd} />;\n'
    );
    write(
      repo,
      'apps/client/src/presence-copy.ts',
      "const TAKING_LONGER = 'this is taking longer than usual';\n" +
        'export const line = (who: string) => `${who} is still working, ${TAKING_LONGER}`;\n'
    );
    git(repo, 'commit', '-am', 'copy: register and casing');

    const findings = runCopySpecGuard(repo, base);
    expect(findings.map((finding) => `${finding.specFile}:${finding.specLine}`).sort()).toEqual([
      'apps/e2e/tests/room-presence.spec.ts:1',
      'apps/e2e/tests/room-presence.spec.ts:2',
      'apps/e2e/tests/session-switcher.spec.ts:1',
      'apps/e2e/tests/session-switcher.spec.ts:2',
      'apps/e2e/tests/settings-dialog.spec.ts:1',
    ]);
  });

  it('sees an uncommitted rewrite, so running it before pushing is worth something', () => {
    const { repo, base } = seedRepo();
    write(
      repo,
      COMPONENT,
      'export function label(pre: string, post: string) {\n  return `Compacted context · ${pre} → ${post} tokens`;\n}\n'
    );

    expect(runCopySpecGuard(repo, base)).toHaveLength(1);
  });
});
