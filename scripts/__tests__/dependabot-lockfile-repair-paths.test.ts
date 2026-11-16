/**
 * Drift guard for `.github/workflows/dependabot-lockfile-repair.yml` (DOR-4458).
 *
 * Dependabot's security updates open a PR per workspace directory ("bump hono
 * in /apps/space") that edits only that package's `package.json` and leaves
 * `pnpm-lock.yaml` alone. When the lockfile does not already satisfy the new
 * range, every job on such a PR dies at `pnpm install --frozen-lockfile` with
 * ERR_PNPM_OUTDATED_LOCKFILE (#3662: 17 jobs red on Nov 12). The repair
 * workflow fixes exactly that with a resolver-only run, but it used to trigger
 * on `pnpm-lock.yaml` alone, so it never ran on those PRs.
 *
 * Losing a path here changes no output until the next such PR goes red, so the
 * trigger is pinned from the file. It also pins the two things that keep the
 * wider trigger safe: the `dependabot[bot]` actor gate and the resolver-only
 * flags. The workflow is read as text, like the other workflow guards here,
 * because this directory has no YAML parser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
const workflow = readFileSync(
  path.join(repo, '.github/workflows/dependabot-lockfile-repair.yml'),
  'utf8'
);

/** The `paths:` entries under `on.pull_request_target`, quotes stripped. */
function triggerPaths(): string[] {
  const block = workflow.split(/^on:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  const list = block.split(/^ {4}paths:\n/m)[1] ?? '';
  return [...list.matchAll(/^ {6}- '?([^'\n]+)'?$/gm)].map((m) => m[1] as string);
}

/** GitHub's path-filter glob, for the subset used here: `*` stops at `/`, `**` does not. */
function matches(glob: string, file: string): boolean {
  const re = glob
    .split('**')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${re}$`).test(file);
}

/** Workspace globs from pnpm-workspace.yaml, e.g. `apps/*`. */
function workspaceGlobs(): string[] {
  const text = readFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'utf8');
  const block = text.split(/^packages:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  return [...block.matchAll(/^ {2}- '?([^'\n]+)'?$/gm)].map((m) => m[1] as string);
}

describe('dependabot-lockfile-repair trigger', () => {
  it('still fires on a lockfile change', () => {
    expect(triggerPaths()).toContain('pnpm-lock.yaml');
  });

  it.each([
    'apps/space/package.json',
    'apps/server/package.json',
    'apps/site/package.json',
    'packages/cli/package.json',
    'package.json',
  ])('fires on a Dependabot PR that changes only %s', (file) => {
    expect(triggerPaths().some((glob) => matches(glob, file))).toBe(true);
  });

  it('covers every workspace package glob in pnpm-workspace.yaml', () => {
    const globs = workspaceGlobs();
    expect(globs.length).toBeGreaterThan(0);
    for (const ws of globs) {
      const sample = `${ws.replace(/\*+/g, 'example')}/package.json`;
      expect(
        triggerPaths().some((glob) => matches(glob, sample)),
        sample
      ).toBe(true);
    }
  });

  it('keeps the actor gate and the resolver-only run that make the wider trigger safe', () => {
    expect(workflow).toContain("if: github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(workflow).toContain(
      'run: pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts'
    );
  });
});
