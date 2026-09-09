/**
 * `config-schema.ts` may not reach a module the OpenAPI registry registers.
 *
 * `apps/server/vitest.config.ts` aliases a handful of `@dorkos/shared/*`
 * subpaths to SRC, and that alias is inherited by every vitest project in the
 * repo, `packages/evals` included. Other `dist/*.js` files reach the same
 * modules by relative imports, which the alias does not rewrite, so a test
 * process legitimately holds BOTH the src and the dist copy of an aliased
 * module. The alias comment states the condition that makes that safe — these
 * modules export "Zod schemas, plain constants, and pure functions over them,
 * nothing whose identity is ever compared" — and says not to widen it without
 * re-measuring.
 *
 * ## What went wrong, and why the comment was not enough
 *
 * The condition can be broken without touching the alias at all, by giving an
 * aliased module a new IMPORT. `config-schema.ts` imported `HarnessIdSchema`
 * from `harness-schemas.ts`. That module also exports
 * `HarnessStatusResponseSchema`, which `apps/server/src/services/core/openapi-registry.ts`
 * hands to `registry.register(...)`. So the src copy of `config-schema` dragged
 * in a src copy of the WHOLE of `harness-schemas`, built on the zod instance
 * vite inlines, while the registry held the dist one.
 *
 * A Zod schema's identity is compared there, by the one thing that matters:
 * `.openapi()` is a method `@asteasolutions/zod-to-openapi` patches onto zod's
 * prototype. The patch landed on one instance and the registry asked the other,
 * so `registry.register('HarnessStatusResponse', …)` threw `TypeError:
 * zodSchema.openapi is not a function` — from inside the package, naming a line
 * in the registry rather than the import that caused it. It surfaced only in
 * `packages/evals`, whose test project reaches `app.ts`, and only on a branch
 * whose diff put evals in turbo's affected set (DOR-1924).
 *
 * ## Why the rule is this shape rather than "no zod imports"
 *
 * `config-schema.ts` already imports `RuntimeEnvironmentSchema`, and has for a
 * long time, green. Carrying a zod schema is not what hurts; being duplicated
 * ALONGSIDE a registered one is. So the rule names the real hazard: no module
 * `config-schema.ts` imports may export a schema the registry registers. It is
 * computed from the registry itself rather than from a list somebody keeps in
 * step, so a schema newly registered there tightens this automatically.
 *
 * The fix when it fires is the one `harness-ids.ts` demonstrates: move the plain
 * values into a constants leaf and import those.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** This package's `src` directory. */
const SRC = join(import.meta.dirname, '..');

/** The server's OpenAPI registry, which is where `.openapi()` is called. */
const REGISTRY = join(
  SRC,
  '..',
  '..',
  '..',
  'apps',
  'server',
  'src',
  'services',
  'core',
  'openapi-registry.ts'
);

/** Every module-level import/re-export specifier in a source file. */
function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gm)].map(
    (m) => m[1] as string
  );
}

/** Every schema identifier `openapi-registry.ts` hands to `registry.register`. */
function registeredSchemaNames(): Set<string> {
  const text = readFileSync(REGISTRY, 'utf8');
  return new Set(
    [...text.matchAll(/registry\.register\(\s*'[^']+'\s*,\s*([A-Za-z0-9_]+)/g)].map(
      (m) => m[1] as string
    )
  );
}

/** The shared modules that export any of `names`, by bare module name. */
function sharedModulesExporting(names: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of readdirSync(SRC, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
    const text = readFileSync(join(SRC, entry.name), 'utf8');
    const hits = [...names].filter((name) =>
      new RegExp(`^\\s*export\\s+const\\s+${name}\\b`, 'm').test(text)
    );
    if (hits.length > 0) out.set(entry.name.replace(/\.ts$/, ''), hits);
  }
  return out;
}

describe('config-schema.ts does not drag a registered schema into the SRC-aliased copy', () => {
  it('imports no shared module that exports a schema the OpenAPI registry registers', () => {
    const registered = registeredSchemaNames();
    // The registry is the instrument, so a scrape that found nothing has to be
    // a red rather than a pass. Most schemas reach the document through
    // `registerPath` and are serialised inline; only a handful are registered as
    // named components, and those are the ones `.openapi()` is called on by
    // NAME — which is where the failure came from. The count is small on
    // purpose; the case below pins the one that matters.
    expect(registered.size).toBeGreaterThanOrEqual(3);

    const dangerous = sharedModulesExporting(registered);
    expect(dangerous.size).toBeGreaterThan(0);

    const imported = importSpecifiers(readFileSync(join(SRC, 'config-schema.ts'), 'utf8'))
      .filter((spec) => spec.startsWith('./'))
      .map((spec) => spec.replace(/^\.\//, '').replace(/\.js$/, ''));

    const offenders = imported
      .filter((mod) => dangerous.has(mod))
      .map((mod) => `${mod} (exports ${dangerous.get(mod)?.join(', ')})`);

    expect(
      offenders,
      `config-schema.ts imports ${offenders.join('; ')}. It is aliased to SRC for every vitest ` +
        `project, so a test process holds both the src and the dist copy of it — and importing a ` +
        `module the OpenAPI registry registers duplicates THAT module's schemas too, on a second ` +
        `zod instance. The .openapi() prototype patch then lands on one instance while the ` +
        `registry asks the other, and register() throws "zodSchema.openapi is not a function". ` +
        `Move the plain values you need into a constants leaf and import those, the way ` +
        `harness-ids.ts carries HARNESS_IDS for the harness enum.`
    ).toEqual([]);
  });

  it('harness-schemas is one of the modules that rule is about', () => {
    // The specific pairing the failure came from, asserted so the case above
    // cannot pass because the registry scrape quietly stopped finding anything.
    const registered = registeredSchemaNames();
    expect(registered).toContain('HarnessStatusResponseSchema');
    expect(sharedModulesExporting(registered).has('harness-schemas')).toBe(true);
  });

  it('harness-ids.ts is a constants leaf, so holding two copies of it is harmless', () => {
    const text = readFileSync(join(SRC, 'harness-ids.ts'), 'utf8');
    expect(text).not.toMatch(/\bfrom\s+'zod'/);
    expect(importSpecifiers(text)).toEqual([]);
    expect(text).toMatch(/export const HARNESS_IDS/);
  });
});
