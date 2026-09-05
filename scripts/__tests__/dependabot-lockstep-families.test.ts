/**
 * Drift guard: Dependabot may never see half of a lockstep family (DOR-1644).
 *
 * A "lockstep family" here is a set of npm packages this repo can only ever
 * hold at ONE version at a time: a parent, its `-sdk` companion, and the
 * per-platform sibling binaries (`-darwin-arm64`, `-win32-x64`, …) that are
 * published at the parent's version and bundled into the packaged desktop app.
 *
 * Dependabot understands none of that. It does not read pnpm `overrides` (where
 * `@anthropic-ai/claude-agent-sdk`'s real pin lives), it does not know that a
 * `-darwin-arm64` package tracks its parent, and it does not know that
 * `@openai/codex-darwin-arm64` is an npm ALIAS of `@openai/codex` rather than a
 * package of its own. PR #1407 (2026-08-31) demonstrated all of it at once: the
 * per-platform claude-agent-sdk siblings went to 0.3.250 against a parent
 * frozen at 0.3.224, and the `@openai/codex` CLI went to 0.150.1 against an
 * `@openai/codex-sdk` still at 0.147.0.
 *
 * Both halves of that were caused by the FIX for the previous problem: the
 * `ignore` list in `.github/dependabot.yml` named three SDKs one at a time, and
 * an ignore that covers a parent but not its siblings does not stop a bump, it
 * splits one. Naming half a family is worse than naming none of it.
 *
 * WHY THIS FILE EXISTS RATHER THAN A COMMENT IN THE CONFIG. Every failure in
 * this class is quiet from the config's own side. `.github/dependabot.yml` is
 * never executed by CI, nothing type-checks it, and a wildcard tidied off one
 * entry — or a new per-platform sibling added to `apps/desktop`'s
 * `optionalDependencies` that no ignore rule covers — produces no red anywhere
 * until Dependabot next opens a group PR, days later, on someone else's watch.
 * The repo's existing guards caught the RESULT (`provision.test.ts`'s DOR-1012
 * lockstep assertion, the `packaged-runtime` job in desktop-smoke.yml) but
 * nothing caught the CAUSE, and one of them caught it too narrowly: the
 * DOR-1012 guard reads only `apps/server/package.json`, so #1407's half-bump of
 * `@openai/codex` sat undetected in `packages/cli` at 0.150.1 for days. The
 * version-parity test below is that guard widened to the whole workspace.
 *
 * NOTE FOR WHOEVER EDITS `.github/dependabot.yml` NEXT: it is in the
 * `scripts-test` workflow's path filters precisely so this file runs on a PR
 * that touches nothing else. If you move the config, move that filter too.
 *
 * STDLIB ONLY. Like its neighbours here, this file imports nothing outside
 * `node:*` — `scripts/` has no package.json of its own, and keeping the
 * dependency surface at zero is what lets these guards run in the cheapest
 * possible job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const dependabotConfigPath = path.join(repoRoot, '.github', 'dependabot.yml');

/**
 * The lockstep families this repo actually has, each named for its parent.
 *
 * This table is the fixture; the tests below check it against reality from both
 * directions, so it cannot quietly rot. Members are written as they appear as
 * KEYS in a package.json (which is also what a Dependabot `dependency-name`
 * pattern is matched against below), not as the packages they may alias to.
 */
const FAMILIES: Record<string, readonly string[]> = {
  // Behind the claude-code adapter boundary. The parent's real pin is the root
  // package.json's `pnpm.overrides` entry, which Dependabot cannot see at all.
  '@anthropic-ai/claude-agent-sdk': [
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/claude-agent-sdk-darwin-arm64',
    '@anthropic-ai/claude-agent-sdk-win32-x64',
  ],
  // The CLI, its SDK companion, and two npm-aliased platform builds of the CLI.
  '@openai/codex': [
    '@openai/codex',
    '@openai/codex-sdk',
    '@openai/codex-darwin-arm64',
    '@openai/codex-win32-x64',
  ],
  // No per-platform siblings in the manifests: the opencode sidecar is
  // provisioned at runtime from OPENCODE_PACKAGE_VERSION in
  // apps/server/src/services/runtimes/opencode/provision.ts, which that file's
  // own test keeps in step with this SDK.
  '@opencode-ai/sdk': ['@opencode-ai/sdk'],
  // NOT ignored in dependabot.yml, deliberately — see the `groups` comment
  // there. Both of these publish every platform sibling at the parent's
  // version, so the single catch-all group carries the whole family in one PR.
  // They are still families, and the version-parity test below still applies.
  esbuild: ['esbuild', '@esbuild/darwin-arm64', '@esbuild/win32-x64'],
  '@ngrok/ngrok': ['@ngrok/ngrok', '@ngrok/ngrok-darwin-arm64', '@ngrok/ngrok-win32-x64-msvc'],
};

/**
 * A per-platform sibling package name: `<parent>-darwin-arm64`,
 * `@scope/win32-x64-msvc`, and the rest of the npm platform-binary convention.
 */
const PLATFORM_SIBLING =
  /(?:^|[-/])(darwin|linux|win32|freebsd|android)-(arm64|x64|ia32|arm|riscv64|loong64|ppc64|s390x)(?:-(?:msvc|gnu|gnueabihf|musl))?$/;

/** One dependency declaration, kept with enough context to name it in a failure. */
interface Declaration {
  /** Where it was declared, e.g. `apps/desktop/package.json optionalDependencies`. */
  label: string;
  /** The dependency key as written in the manifest. */
  name: string;
  /** The raw specifier, e.g. `^0.28.2` or `npm:@openai/codex@0.147.0-darwin-arm64`. */
  specifier: string;
}

/**
 * Every workspace manifest path, plus the repo root.
 *
 * `pnpm-workspace.yaml` is asserted to still be `apps/*` + `packages/*` by a
 * test below rather than parsed, so a third workspace glob added later fails
 * loudly here instead of silently escaping every check in this file.
 */
function manifestPaths(): string[] {
  const dirs = ['.'];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(group, entry.name));
    }
  }
  return dirs
    .map((dir) => path.join(dir, 'package.json'))
    .filter((rel) => existsSync(path.join(repoRoot, rel)));
}

/** Every dependency declared anywhere in the workspace, in every dependency block. */
function allDeclarations(): Declaration[] {
  const out: Declaration[] = [];
  for (const rel of manifestPaths()) {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const block of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const deps = manifest[block];
      if (typeof deps !== 'object' || deps === null) continue;
      for (const [name, specifier] of Object.entries(deps as Record<string, string>)) {
        out.push({ label: `${rel} ${block}`, name, specifier });
      }
    }
    // The root's pnpm.overrides are declarations too — and they are the ones
    // Dependabot is blind to, so they are exactly the ones worth checking.
    // Skip the selector forms (`vite@7`, `a>b`), which pin a transitive
    // resolution rather than a direct dependency of this repo.
    if (rel === 'package.json') {
      const pnpmBlock = manifest.pnpm as { overrides?: Record<string, string> } | undefined;
      for (const [name, specifier] of Object.entries(pnpmBlock?.overrides ?? {})) {
        if (name.includes('>') || name.lastIndexOf('@') > 0) continue;
        out.push({ label: 'package.json pnpm.overrides', name, specifier });
      }
    }
  }
  return out;
}

/**
 * The version a specifier resolves to for parity purposes, or `null` when it
 * carries none to compare (`workspace:*`, `*`, a git or file URL).
 *
 * Strips range operators (`^0.28.2` -> `0.28.2`), unwraps npm aliases
 * (`npm:@openai/codex@0.147.0-darwin-arm64` -> `0.147.0-darwin-arm64`) and then
 * strips the platform suffix an aliased platform build carries in its version
 * (`0.147.0-darwin-arm64` -> `0.147.0`), which is what makes an aliased sibling
 * comparable with its parent at all.
 */
function comparableVersion(specifier: string): string | null {
  let value = specifier;
  if (value.startsWith('npm:')) {
    const at = value.lastIndexOf('@');
    if (at <= 'npm:'.length) return null;
    value = value.slice(at + 1);
  }
  if (/^(workspace:|file:|link:|git|https?:)/.test(value) || value === '*' || value === '') {
    return null;
  }
  value = value.replace(/^[~^><= ]+/, '');
  value = value.replace(PLATFORM_SIBLING, '');
  return /^\d+\.\d+\.\d+/.test(value) ? value : null;
}

/** One `- dependency-name:` entry from a dependabot `ignore:` list. */
interface IgnoreEntry {
  /** The pattern, e.g. `@openai/codex*`. */
  pattern: string;
  /** `version-update:semver-*` restrictions, empty when the entry ignores everything. */
  updateTypes: string[];
}

/**
 * Every `dependency-name` entry in `.github/dependabot.yml`, with the
 * `update-types` that follow it.
 *
 * A deliberately small scanner rather than a YAML dependency (see the file
 * header on the stdlib-only rule). It reads the whole file rather than trying
 * to locate one ecosystem's `ignore:` block: this repo has exactly one such
 * block, and a scanner that walks everything cannot quietly stop matching when
 * indentation or key order changes. A test below asserts it found the entries
 * we know are there, so "the parser silently returned nothing" is itself a
 * failure rather than a pass.
 */
function parseIgnoreEntries(yaml: string): IgnoreEntry[] {
  const entries: IgnoreEntry[] = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*-\s+dependency-name:\s*'?"?([^'"\s]+)'?"?\s*$/.exec(lines[i] ?? '');
    if (!match) continue;
    const entry: IgnoreEntry = { pattern: match[1] ?? '', updateTypes: [] };
    // update-types, if present, is the next non-comment line: either an inline
    // flow sequence or a block list of `- version-update:...` items.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? '';
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const inline = /^\s*update-types:\s*\[(.*)\]\s*$/.exec(line);
      if (inline) {
        entry.updateTypes = (inline[1] ?? '')
          .split(',')
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else if (/^\s*update-types:\s*$/.test(line)) {
        for (let k = j + 1; k < lines.length; k++) {
          const item = /^\s*-\s*['"]?(version-update:[^'"\s]+)['"]?\s*$/.exec(lines[k] ?? '');
          if (!item) break;
          entry.updateTypes.push(item[1] ?? '');
        }
      }
      break;
    }
    entries.push(entry);
  }
  return entries;
}

/** Does a dependabot `dependency-name` pattern (with `*` wildcards) match this package? */
function patternMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

const declarations = allDeclarations();
const ignoreEntries = parseIgnoreEntries(readFileSync(dependabotConfigPath, 'utf8'));

/**
 * Ignore entries that suppress a package outright, as opposed to only its
 * majors. The blanket `- dependency-name: '*'` + `version-update:semver-major`
 * entry is NOT one of these: it stops majors for everything, which says nothing
 * about whether a family travels together on a minor or patch bump — the bump
 * size every one of these families has actually broken on.
 */
const blanketIgnores = ignoreEntries.filter((entry) => entry.updateTypes.length === 0);

describe('dependabot lockstep families', () => {
  it('parses the dependabot config it is asserting against', () => {
    // Anti-vacuity: every assertion below is over `ignoreEntries`, so a scanner
    // that quietly matched nothing would make this whole file pass while
    // checking nothing at all.
    expect(ignoreEntries.length).toBeGreaterThan(0);
    expect(ignoreEntries).toContainEqual({
      pattern: '*',
      updateTypes: ['version-update:semver-major'],
    });
    expect(blanketIgnores.length).toBeGreaterThan(0);
  });

  it('assumes the workspace globs this scanner was written for', () => {
    // manifestPaths() hard-codes apps/* + packages/*. If a third glob is added,
    // fail here rather than silently checking a subset of the workspace.
    const workspace = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const globs = [...workspace.matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
    expect(globs).toEqual(['apps/*', 'packages/*']);
  });

  it('names only families that really exist in the workspace', () => {
    for (const [family, members] of Object.entries(FAMILIES)) {
      for (const member of members) {
        const found = declarations.some((d) => d.name === member);
        expect(found, `${family}: ${member} is in the table but declared nowhere`).toBe(true);
      }
    }
  });

  it('claims every per-platform sibling package in the workspace', () => {
    // The other direction: a sibling added to apps/desktop's
    // optionalDependencies for a NEW parent must join a family here, or it
    // inherits none of the protections below.
    const claimed = new Set(Object.values(FAMILIES).flat());
    const unclaimed = [
      ...new Set(declarations.filter((d) => PLATFORM_SIBLING.test(d.name)).map((d) => `${d.name}`)),
    ].filter((name) => !claimed.has(name));
    expect(unclaimed, 'per-platform sibling packages belonging to no family in FAMILIES').toEqual(
      []
    );
  });

  it('ignores each family whole, or not at all', () => {
    // THE RULE (DOR-1644). An `ignore` entry that covers a parent but not its
    // siblings does not stop a bump — it splits one, which is how #1407 shipped
    // per-platform binaries 26 patch versions ahead of the SDK they belong to.
    for (const [family, members] of Object.entries(FAMILIES)) {
      const ignored = members.filter((member) =>
        blanketIgnores.some((entry) => patternMatches(entry.pattern, member))
      );
      const partly = ignored.length > 0 && ignored.length < members.length;
      expect(
        partly,
        `${family} is only partly ignored in .github/dependabot.yml: ` +
          `covered [${ignored.join(', ')}], uncovered ` +
          `[${members.filter((m) => !ignored.includes(m)).join(', ')}]. ` +
          `Ignore the whole family (a trailing '*' usually does it) or none of it.`
      ).toBe(false);
    }
  });

  it('holds every family at one version across every manifest', () => {
    // The DOR-1012 lockstep guard, widened from apps/server to the whole
    // workspace and to all five families. #1407's `@openai/codex` half-bump
    // survived in packages/cli precisely because the original only read one
    // manifest.
    for (const [family, members] of Object.entries(FAMILIES)) {
      const seen = new Map<string, string[]>();
      for (const decl of declarations) {
        if (!members.includes(decl.name)) continue;
        const version = comparableVersion(decl.specifier);
        if (version === null) continue;
        seen.set(version, [...(seen.get(version) ?? []), `${decl.label}: ${decl.name}`]);
      }
      expect(
        [...seen.keys()].sort(),
        `${family} is declared at more than one version: ` +
          [...seen.entries()].map(([v, where]) => `${v} (${where.join(', ')})`).join(' vs ')
      ).toHaveLength(seen.size === 0 ? 0 : 1);
    }
  });
});
