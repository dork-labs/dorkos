/**
 * Compiles every docs `.mdx` file that carries a `vocab-allow` marker through
 * the real `@mdx-js/mdx` compiler — the same one apps/site's docs build uses
 * (DOR-2508, second review round).
 *
 * WHY THIS EXISTS. `check-vocab-gate.ts`'s docs scan treats a `vocab-allow`
 * marker as plain text: it only checks that the substring `vocab-allow`
 * appears on the violating line, never that the marker is written as valid
 * MDX. An HTML comment (`<!-- vocab-allow: reason -->`) reads as an ordinary
 * comment in plain Markdown and is invisible to the gate's own scanner (which
 * blanks nothing there — it doesn't need to), but MDX parses a bare `<` as
 * the start of a JSX tag, and `<!--` is not a valid tag name. Four real docs
 * files shipped with exactly that mistake — `docs/concepts/relay.mdx`,
 * `docs/guides/relay-messaging.mdx`, `docs/guides/workspaces.mdx`,
 * `docs/marketplace/index.mdx` — and every one of them would have failed to
 * build, not just failed to read politely. Nothing else in this repo would
 * have caught that before a reader's browser (or `apps/site`'s build) did:
 * the vocab gate has no opinion on comment syntax, and MDX compilation only
 * happens inside `apps/site`'s own build, which this script's tests never run.
 *
 * WHAT IT CHECKS. Every `.mdx` file under `docs/` containing the string
 * `vocab-allow` is compiled with `@mdx-js/mdx`'s `compile()` — syntax only,
 * the same check a build would fail on before ever reaching a browser. It
 * does not render the page, resolve `import`ed Fumadocs components, or
 * validate their props; catching those needs the real `apps/site` build,
 * which is out of scope for a `scripts/` test. A file with no marker is not
 * checked here — the docs vocab gate itself is enough evidence that ordinary
 * prose without special JSX syntax compiles fine, and compiling all 300+
 * docs files on every run would be slow for a check whose failure mode is
 * specific to hand-written inline JSX.
 *
 * HOW IT RESOLVES `@mdx-js/mdx`. That package is not a direct dependency of
 * anything under `scripts/`, so a bare `import('@mdx-js/mdx')` fails: pnpm's
 * isolated `node_modules` only makes a package's OWN dependencies resolvable
 * from its own directory, not from an unrelated one. `apps/site` depends on
 * `fumadocs-mdx` directly, which depends on `@mdx-js/mdx`, so walking that
 * real chain with two `createRequire` calls finds the exact version the site
 * build actually uses, without hardcoding a pnpm store path that would break
 * on the next version bump.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../..');
const MARKER = 'vocab-allow';

/** The subset of `@mdx-js/mdx`'s exports this file uses. */
interface MdxModule {
  compile: (text: string, options: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Resolve and load `@mdx-js/mdx`'s real `compile` by walking pnpm's actual
 * dependency graph from `apps/site`'s own declared `fumadocs-mdx` dependency.
 * See the module doc for why this beats a hardcoded store path.
 */
async function loadMdxCompiler(): Promise<MdxModule['compile']> {
  const siteRequire = createRequire(join(REPO_ROOT, 'apps/site/package.json'));
  const fumadocsMdxEntry = siteRequire.resolve('fumadocs-mdx');
  const nestedRequire = createRequire(fumadocsMdxEntry);
  const mdxEntry = nestedRequire.resolve('@mdx-js/mdx');
  const mod = (await import(mdxEntry)) as MdxModule;
  return mod.compile;
}

/** Every `.mdx` file under `docs/` whose raw text contains {@link MARKER}. */
function findMarkedDocs(): string[] {
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (full.endsWith('.mdx') && readFileSync(full, 'utf8').includes(MARKER)) {
        found.push(full);
      }
    }
  }

  walk(join(REPO_ROOT, 'docs'));
  return found;
}

describe('docs files carrying a vocab-allow marker compile as real MDX', () => {
  it('every marked file compiles with the real @mdx-js/mdx compiler', async () => {
    const compile = await loadMdxCompiler();
    const files = findMarkedDocs();
    // A regression canary with nothing to check is not a canary — if this
    // ever drops to zero, either the sweep removed every marker (update this
    // assertion deliberately) or the marker string changed out from under it.
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      try {
        await compile(text, {});
      } catch (error) {
        failures.push(`${file.slice(REPO_ROOT.length + 1)}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the exact mistake this test exists to catch: an HTML-style marker fails to compile', async () => {
    const compile = await loadMdxCompiler();
    await expect(
      compile('### Heading <!-- vocab-allow: reason -->\n\nBody text.\n', {})
    ).rejects.toThrow(/vocab-allow|comment|character/i);
  });

  it('the JSX-comment marker this repo uses instead compiles cleanly', async () => {
    const compile = await loadMdxCompiler();
    await expect(
      compile('### Heading {/* vocab-allow: reason */}\n\nBody text.\n', {})
    ).resolves.toBeDefined();
  });
});
