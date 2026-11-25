/**
 * A pull request that changes the user config's shape must bring the conf
 * migration it needs, or say in writing why it needs none (DOR-5123).
 *
 * WHY THIS EXISTS. The manual release had a person read the schema diff and
 * ask "does this need a migration?" (`/system:release` Check 6). The daily
 * release has no person, so the question moves to the pull request that makes
 * the change, where its author still knows the answer. Missing migrations fail
 * silently: an upgraded install keeps a config the new code does not describe.
 *
 * WHAT IT COMPARES. The SHAPE of `UserConfigSchema` (`shape.ts`),
 * held in `scripts/config-migration/shape.json`, at the base and at HEAD. A
 * comment, a reworded description or a changed default is not a shape change.
 * HEAD's file must match the live schema; `--update` rewrites it.
 *
 * WHAT NEEDS A MIGRATION (each reported once, at the highest path it touches):
 *   - added:   a new member inside a section a stored file can already hold
 *              (`ui.composer`, `accounts[].color`). conf fills in only whole
 *              TOP-LEVEL sections, so nothing else writes it to an existing file
 *              (the "Which of these bodies is a real no-op" docblock above
 *              `CONFIG_MIGRATIONS`). A new top-level section, and a new member
 *              that is optional with no default, need none.
 *   - removed: any path that is gone, at any depth; a rename is a removal plus
 *              an addition, so it lands here too. Stored files still hold it.
 *   - retyped: a path that now refuses a value it used to accept (a type
 *              change, an enum value dropped, newly required). Widening is free.
 *
 * WHAT SATISFIES IT. The PR changes `CONFIG_MIGRATIONS` itself: it adds a key,
 * or changes the code (not just comments) of a key above `VERSION`. Shipped
 * keys are frozen by `migration-append-only`, not here. Or the PR adds an
 * entry to `scripts/config-migration/no-migration.json` for each change, with
 * `path`, `change` and a `reason` a reviewer can check. Only entries the PR
 * adds count, so an old one can never cover a later change; an added entry
 * that matches nothing fails, so the file holds no guesses.
 *
 * Usage:
 *   pnpm check:config-migration                   HEAD's shape file is current
 *   pnpm check:config-migration -- --base <ref>   ...and the changes since <ref> are covered
 *   pnpm check:config-migration -- --update       rewrite the shape file from the schema
 *
 * Exit 0 pass, 1 a finding, 2 could not run (a ref git does not have, a file it
 * cannot read): a gate that cannot measure must not pass.
 *
 * @module scripts/config-migration/check-config-migration
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UserConfigSchema } from '../../packages/shared/src/config-schema.ts';
import { isOptionalWithoutDefault, onlyWidened, shapeOf, type ConfigShape } from './shape.ts';
import { MIGRATIONS_FILE, compareSemver, readMigrationTable } from '../release/migration-table.ts';

/** The committed shape, repo-relative. */
export const SHAPE_PATH = 'scripts/config-migration/shape.json';

/** The written "no migration needed" entries, repo-relative. */
export const WAIVERS_PATH = 'scripts/config-migration/no-migration.json';

const ROOT = join(import.meta.dirname, '..', '..');
const UPDATE_COMMAND = 'pnpm check:config-migration -- --update';

/** How one path changed. */
export type ChangeKind = 'added' | 'removed' | 'retyped';

/** One change between two shapes. */
export interface ShapeChange {
  /** How it changed. */
  kind: ChangeKind;
  /** The path. */
  path: string;
  /** Its signature at the base. */
  before?: string;
  /** Its signature at HEAD. */
  after?: string;
  /** Set when the change needs no migration, saying why. */
  free?: string;
}

/** One "no migration needed" entry. */
export interface Waiver {
  /** The path, as the finding names it. */
  path: string;
  /** The change, as the finding names it. */
  change: ChangeKind;
  /** Why no migration is needed, in words a reviewer can check. */
  reason: string;
}

/** Everything one run compares. */
export interface CheckInput {
  /** The shape at the base, or null when the base had no shape file yet. */
  base: ConfigShape | null;
  /** The shape at HEAD. */
  head: ConfigShape;
  /** The migrations file at the base, or null when it had none. */
  baseMigrations: string | null;
  /** The migrations file at HEAD. */
  headMigrations: string;
  /** HEAD's `VERSION`: the last release. */
  released: string;
  /** The waivers at the base. */
  baseWaivers: readonly Waiver[];
  /** The waivers at HEAD. */
  headWaivers: readonly Waiver[];
}

/** The parent of a path: `a.b[]` for `a.b[].c`, `a.b` for `a.b[]`, `''` at the top. */
export function parentPath(path: string): string {
  if (path.endsWith('[]')) return path.slice(0, -2);
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(0, dot);
}

/** Every change from `before` to `after`, each at the highest path it touches. */
export function shapeChanges(before: ConfigShape, after: ConfigShape): ShapeChange[] {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = new Set<string>();
  const under = (path: string) => {
    for (let parent = parentPath(path); parent; parent = parentPath(parent))
      if (changed.has(parent)) return true;
    return false;
  };
  const changes: ShapeChange[] = [];
  for (const path of paths) {
    const was = before[path];
    const now = after[path];
    if (was === now || under(path)) continue;
    if (was !== undefined && now !== undefined && onlyWidened(was, now)) continue;
    changed.add(path);
    if (was === undefined) {
      const free = !parentPath(path)
        ? 'a new top-level section, which conf writes from its defaults'
        : isOptionalWithoutDefault(now!)
          ? 'optional with no default, so there is nothing to write'
          : undefined;
      changes.push({ kind: 'added', path, after: now!, ...(free ? { free } : {}) });
    } else if (now === undefined) changes.push({ kind: 'removed', path, before: was });
    else changes.push({ kind: 'retyped', path, before: was, after: now });
  }
  return changes;
}

/**
 * How the PR changed `CONFIG_MIGRATIONS`, or undefined when it did not: a key
 * added, or the code of a key above `released` changed.
 */
export function migrationChange(
  baseText: string | null,
  headText: string,
  released: string
): string | undefined {
  const base = new Map(
    (baseText === null ? [] : readMigrationTable(baseText)).map((entry) => [entry.key, entry.code])
  );
  for (const entry of readMigrationTable(headText)) {
    const was = base.get(entry.key);
    if (was === undefined) return `adds the key '${entry.key}'`;
    if (was !== entry.code && compareSemver(entry.key, released) > 0)
      return `changes the unreleased key '${entry.key}'`;
  }
  return undefined;
}

/** Parse the waiver file; throws on anything a reviewer could not check. */
export function readWaivers(text: string, where: string): Waiver[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where} is not JSON`, { cause: error });
  }
  const list = (parsed as { waivers?: unknown } | null)?.waivers;
  if (!Array.isArray(list)) throw new Error(`${where} has no "waivers" list`);
  return list.map((item, index) => {
    const { path, change, reason } = (item ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || !path)
      throw new Error(`${where} waiver ${index + 1} has no "path"`);
    if (change !== 'added' && change !== 'removed' && change !== 'retyped')
      throw new Error(
        `${where} waiver ${index + 1} needs "change": "added", "removed" or "retyped"`
      );
    if (typeof reason !== 'string' || reason.trim().split(/\s+/).length < 4)
      throw new Error(`${where} waiver ${index + 1} needs a "reason" of at least four words`);
    return { path, change, reason };
  });
}

/** Run the comparison; returns one line per finding, empty when the PR is covered. */
export function checkConfigMigration(input: CheckInput): { findings: string[]; notes: string[] } {
  if (input.base === null)
    return {
      findings: [],
      notes: [`the base has no ${SHAPE_PATH}, so there is nothing to compare`],
    };
  const changes = shapeChanges(input.base, input.head);
  const notes = changes
    .filter((change) => change.free)
    .map((change) => `${change.kind} ${change.path}: needs no migration, ${change.free}`);
  const needed = changes.filter((change) => !change.free);
  const migration = migrationChange(input.baseMigrations, input.headMigrations, input.released);
  const added = input.headWaivers.filter(
    (waiver) =>
      !input.baseWaivers.some(
        (old) =>
          old.path === waiver.path && old.change === waiver.change && old.reason === waiver.reason
      )
  );
  const findings: string[] = [];
  if (migration && needed.length) notes.push(`covered: the PR ${migration} in ${MIGRATIONS_FILE}`);
  for (const change of migration ? [] : needed) {
    const waiver = added.find(
      (entry) => entry.path === change.path && entry.change === change.kind
    );
    if (waiver) notes.push(`${change.kind} ${change.path}: no migration, because ${waiver.reason}`);
    else findings.push(describe(change));
  }
  for (const waiver of added)
    if (!changes.some((change) => change.path === waiver.path && change.kind === waiver.change))
      findings.push(
        `${WAIVERS_PATH}: the entry for ${waiver.change} ${waiver.path} matches no change in this PR. Remove it.`
      );
  return { findings, notes };
}

function describe(change: ShapeChange): string {
  const fix = `Add a migration key to ${MIGRATIONS_FILE} (the adding-config-fields skill), or add {"path": "${change.path}", "change": "${change.kind}", "reason": "..."} to ${WAIVERS_PATH} saying why none is needed.`;
  if (change.kind === 'added')
    return `added ${change.path} (${change.after}): conf never writes a new member into a section a stored file already holds. ${fix}`;
  if (change.kind === 'removed')
    return `removed ${change.path} (was ${change.before}): stored files still hold it, and a rename needs its value moved. ${fix}`;
  return `retyped ${change.path}: ${change.before} became ${change.after}, which refuses a value it used to accept. ${fix}`;
}

/** The shape of the live `UserConfigSchema`, read the way conf's bridge reads it. */
export function liveShape(): ConfigShape {
  return shapeOf(UserConfigSchema.toJSONSchema({ target: 'jsonSchema2019-09' }));
}

function serialize(shape: ConfigShape): string {
  return `${JSON.stringify(shape, null, 2)}\n`;
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** A file's text at `ref`, or null when that commit has no such file. */
function readAt(ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}

function parseShape(text: string, where: string): ConfigShape {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${where} is not a path-to-signature map`);
  return parsed as ConfigShape;
}

/** Run the CLI over `argv`; returns the exit code. */
export function main(argv: readonly string[]): number {
  const live = liveShape();
  const shapeFile = join(ROOT, SHAPE_PATH);
  if (argv.includes('--update')) {
    writeFileSync(shapeFile, serialize(live));
    console.log(`config-migration: wrote ${Object.keys(live).length} paths to ${SHAPE_PATH}`);
    return 0;
  }
  if (readFileSync(shapeFile, 'utf8') !== serialize(live)) {
    console.error(
      `config-migration: ${SHAPE_PATH} does not match UserConfigSchema. Run \`${UPDATE_COMMAND}\` and commit the result.`
    );
    return 1;
  }
  const at = argv.indexOf('--base');
  if (at === -1) {
    console.log(`config-migration: ${SHAPE_PATH} is current. Pass --base <ref> to check changes.`);
    return 0;
  }
  const base = argv[at + 1];
  if (!base) throw new Error('--base needs a ref');
  try {
    git(['cat-file', '-e', `${base}^{commit}`]);
  } catch (error) {
    throw new Error(`--base ${base} is not a commit this checkout has`, { cause: error });
  }
  const baseShape = readAt(base, SHAPE_PATH);
  const baseWaivers = readAt(base, WAIVERS_PATH);
  const { findings, notes } = checkConfigMigration({
    base: baseShape === null ? null : parseShape(baseShape, `${SHAPE_PATH} at ${base}`),
    head: live,
    baseMigrations: readAt(base, MIGRATIONS_FILE),
    headMigrations: readFileSync(join(ROOT, MIGRATIONS_FILE), 'utf8'),
    released: readFileSync(join(ROOT, 'VERSION'), 'utf8').trim(),
    baseWaivers: baseWaivers === null ? [] : readWaivers(baseWaivers, `${WAIVERS_PATH} at ${base}`),
    headWaivers: readWaivers(readFileSync(join(ROOT, WAIVERS_PATH), 'utf8'), WAIVERS_PATH),
  });
  for (const note of notes) console.log(`config-migration: ${note}`);
  if (!findings.length) {
    console.log('config-migration: every config shape change is covered.');
    return 0;
  }
  console.error(`config-migration: ${findings.length} change(s) need a migration or a reason:`);
  for (const finding of findings) console.error(`  ${finding}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `config-migration: cannot run: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
}
