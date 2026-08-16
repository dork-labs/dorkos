/**
 * A setting whose VALUE was written by a build that widened it.
 *
 * ## The defect this exists for
 *
 * `version-skew.ts` closed one half of config version skew: a key this build
 * does not declare no longer condemns `~/.dork/config.json`. This is the other
 * half, and on a machine that boots several builds a day it is the next most
 * likely way to lose a config file.
 *
 * A newer build WIDENS a setting both builds declare — adds a `ui.theme` value,
 * raises a bound, allows a type that was not allowed before. The person picks
 * the new value. Then an older build starts, Ajv rejects a key that build DOES
 * declare, and the recovery path in `config-manager.ts` reads that as damage:
 * backup, wipe, defaults. Proven with `ui.theme: 'midnight'` against a build
 * without that member — one backup, one fresh config.
 *
 * The structural argument is the same one DOR-1221 made. That value belongs to
 * another build. It is not damage, and replacing somebody's whole file over it
 * is the wrong answer.
 *
 * ## The policy: which violations are skew, and which are damage
 *
 * **Skew — tolerated here.** A violation on a NAMED SCALAR LEAF that carries a
 * schema default: `ui.theme`, `server.port`, `runtimes.codex.defaultEffort`.
 * Adding an enum member, raising a cap, allowing a new primitive type are
 * routine, additive schema changes, and this is exactly the shape they leave
 * behind in an older build's schema.
 *
 * **Damage — still condemns, and still recovers.** Everything else. JSON that
 * will not parse. A section, object or list whose SHAPE is wrong (`mesh.scanRoots`
 * holding a string, `ui.sidebar` holding a list). A missing required field with
 * no default to supply it. Restructuring a container is not an additive change;
 * it ships with a migration, and DorkOS's own writers never produce it in
 * passing.
 *
 * ## Why the line is drawn at a NAMED leaf
 *
 * Because tolerance has to be paid for on the write path, and only a named leaf
 * can pay. Rule 2 of this feature is that the value survives on disk for the
 * build that owns it — an older build must not quietly delete a newer build's
 * setting the next time it saves a preference. For a named leaf that is exact:
 * one key, one value, carried back by {@link preserveWidenedLeaves}. Inside a
 * LIST or a RECORD it is not: an element has no name, only a position, and
 * matching a stored element to a written one by index is a guess whose wrong
 * answers write one person's setting onto another's row. `preserveUnknownKeys`
 * refused arrays and records for that same reason, and this refuses them for it
 * too — the carve-outs are the same three, with the same argument behind them.
 *
 * So a widened value inside a list (`ui.statusBar.pins` gaining a new pin id) or
 * a record (`workbench.defaultViewers`) still condemns the file. That is the
 * residual, and it is named in `contributing/configuration.md` rather than left
 * for somebody to discover.
 *
 * ## How it works, in three moves
 *
 * conf validates with Ajv BEFORE DorkOS ever sees the data, and it validates on
 * every read of the file, not just at boot (`conf@15`, `get store()`). So there
 * is no error to catch and reclassify after the fact — whatever Ajv refuses is
 * simply unreadable. The tolerance therefore has to be in the schema:
 *
 * 1. {@link relaxWidenedLeaves} replaces every named scalar leaf in the
 *    generated schema with a stub that carries only its `default`. Ajv stops
 *    checking those positions entirely, and still fills in a missing one.
 * 2. {@link repairWidenedLeaves} puts the checking back where the authoritative
 *    schema lives: Zod, inside DorkOS, at the read boundary. A leaf whose stored
 *    value its own Zod field refuses falls back to its own schema default, so
 *    this build runs correctly on everything it can read.
 * 3. {@link preserveWidenedLeaves} carries the stored value back onto any write
 *    that did not name that leaf, so the build that owns it gets it back.
 *
 * Zod rather than a second JSON-Schema validator, because Zod is the
 * authoritative schema in this codebase and everything the generated schema says
 * is derived from it. Reimplementing `enum`/`minimum`/`pattern`/`format` by hand
 * to re-check what we had just stopped Ajv from checking would have been a
 * second, quietly divergent opinion about what the config means.
 *
 * The two sides are held together at ONE place: a leaf is relaxed in step 1 only
 * if step 2 can resolve its Zod field and get a default out of it. So "what Ajv
 * stopped checking" and "what DorkOS checks instead" are the same set by
 * construction, rather than two lists that have to be kept in agreement.
 *
 * ## What this does NOT do
 *
 * It does not make an unreadable value readable. The older build runs on the
 * default, and shows the default, because it has no idea what `'midnight'` is.
 * The gain is that it keeps everything else the person ever configured.
 *
 * @module services/core/config/widened-leaves
 */
import { isDeepStrictEqual } from 'node:util';
import { SENSITIVE_CONFIG_KEYS, UserConfigSchema } from '@dorkos/shared/config-schema';
import type { z } from 'zod';
import { isPlainObject } from './version-skew.js';

/**
 * A leaf whose stored value this build could not interpret.
 *
 * Produced by {@link repairWidenedLeaves} on the read path and consumed by
 * {@link preserveWidenedLeaves} on the write path. The pair is what makes the
 * tolerance safe: `used` is the value this build handed out, so a later write
 * carrying that exact value is a write that never knew about `stored`.
 */
export interface WidenedLeaf {
  /** Dot-path from the top of the config, e.g. `ui.theme`. */
  path: string;
  /** The value on disk. It belongs to another build, so it must survive. */
  stored: unknown;
  /** The schema default this build ran with instead. */
  used: unknown;
}

/** Nothing to carry — shared so the common path allocates nothing. */
const NO_LEAVES: readonly WidenedLeaf[] = [];

/** Tells "the path is absent" apart from "the path holds `undefined`". */
const MISSING = Symbol('missing');

/**
 * Whether a schema node describes a primitive rather than a container.
 *
 * Deliberately conservative: anything that could hold other values — declared
 * `properties`, `items`, a record's `additionalProperties` schema, a `$ref`, or
 * a union with a non-scalar branch — is a container, and containers are never
 * relaxed. A nullable field (`anyOf: [{type:'string'},{type:'null'}]`) is a
 * scalar, which is the case this has to get right.
 *
 * @param node - One node of the generated JSON Schema.
 */
function isScalarNode(node: Record<string, unknown>): boolean {
  if (node.type === 'object' || node.type === 'array') return false;
  if (node.properties !== undefined) return false;
  if (node.items !== undefined || node.prefixItems !== undefined) return false;
  if (isPlainObject(node.additionalProperties)) return false;
  if (node.$ref !== undefined) return false;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) return false;
    if (!branches.every((branch) => isPlainObject(branch) && isScalarNode(branch))) return false;
  }
  return true;
}

/**
 * What a relaxed leaf leaves behind: its default, and nothing that can refuse a
 * value.
 *
 * The `default` has to stay. conf builds Ajv with `useDefaults`, so a leaf
 * missing from the file is filled in during validation; dropping the default
 * along with the constraints would turn "tolerate a widened value" into "forget
 * every unset preference".
 *
 * The `description` is kept only so that a person reading the schema conf holds
 * — in a debugger, or dumped from `CONF_JSON_SCHEMA` — still sees what the field
 * is for. Nothing renders it: `/api/docs` and the OpenAPI export build their own
 * schema from Zod and never see this copy.
 *
 * @param node - The leaf node being replaced.
 */
function leafStub(node: Record<string, unknown>): Record<string, unknown> {
  const stub: Record<string, unknown> = { default: node.default };
  if (typeof node.description === 'string') stub.description = node.description;
  return stub;
}

/** One leaf Ajv no longer checks, and everything needed to check it here. */
interface RelaxedLeaf {
  /** The top-level section it belongs to, e.g. `runtimes`. */
  section: string;
  /** Dot-path from the top of the config, e.g. `runtimes.codex.defaultEffort`. */
  path: string;
  /** The Zod field itself — enum, bound, nullability and all. */
  schema: z.ZodType;
  /** Its own default, resolved once, and the value a failing read falls back to. */
  fallback: unknown;
}

/**
 * The leaves Ajv stopped checking, and how DorkOS checks them instead.
 *
 * Built once by {@link relaxWidenedLeaves} and threaded through the read and
 * write paths, so the set the schema opened and the set DorkOS guards are the
 * same set by construction rather than by two lists agreeing.
 */
export interface WidenedLeafPolicy {
  /** Every relaxed dot-path, for lookups and drift guards. */
  readonly paths: ReadonlySet<string>;
  /** The relaxed leaves of each top-level section. */
  readonly bySection: ReadonlyMap<string, readonly RelaxedLeaf[]>;
}

/** How far a Zod field is unwrapped looking for the object underneath. */
const MAX_ZOD_WRAPPERS = 8;

/** The internals of a Zod field that this module reads, and only these. */
type ZodInternals = { type?: string; innerType?: z.ZodType; shape?: Record<string, z.ZodType> };

/**
 * The `shape` of the object a Zod field describes, through any wrappers.
 *
 * Every section is `z.object({...}).default(...)`, and nested ones add
 * `.optional()` or `.nullable()`, so the object is never the outermost thing.
 *
 * @param schema - The field to look inside.
 */
function objectShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  let current = schema;
  for (let depth = 0; depth < MAX_ZOD_WRAPPERS; depth++) {
    const def = current.def as ZodInternals;
    if (def.type === 'object' && def.shape !== undefined) return def.shape;
    if (def.innerType === undefined) return undefined;
    current = def.innerType;
  }
  return undefined;
}

/**
 * The Zod field at a dot-path, left wrapped.
 *
 * Wrapped on purpose: `z.string().nullable().default(null)` only accepts `null`
 * while its `.nullable()` is still on, and stripping wrappers off the LEAF would
 * make this reject the very values the schema allows.
 *
 * @param segments - The path from the top of the config.
 */
function resolveLeafSchema(segments: readonly string[]): z.ZodType | undefined {
  let current = UserConfigSchema as unknown as z.ZodType;
  for (const segment of segments) {
    const shape = objectShape(current);
    const next = shape?.[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/** Walk one `properties` map, relaxing the scalar leaves under it. */
function relaxIn(
  properties: Record<string, unknown>,
  segments: readonly string[],
  leaves: RelaxedLeaf[]
): void {
  for (const [key, child] of Object.entries(properties)) {
    if (!isPlainObject(child)) continue;
    const here = [...segments, key];
    if (isScalarNode(child)) {
      // No default, no tolerance: the repair below can only fall back to a value
      // the schema itself supplies, and a leaf without one has nothing to fall
      // back to. `version` is the leaf this excludes — a build that changes the
      // config format outright is not merely widening a setting.
      if (!('default' in child)) continue;
      // The two sides are made consistent HERE, which is the point of resolving
      // Zod during the relaxation rather than at the read. A leaf Zod cannot
      // reach, or cannot supply a default for, is a leaf DorkOS could not check
      // if Ajv stopped — so Ajv keeps it.
      const schema = resolveLeafSchema(here);
      const fallback = schema?.safeParse(undefined);
      if (schema === undefined || fallback?.success !== true) continue;
      properties[key] = leafStub(child);
      leaves.push({
        section: here[0]!,
        path: here.join('.'),
        schema,
        fallback: fallback.data,
      });
      continue;
    }
    // Only `properties` is followed. Not `items`, not a record's
    // `additionalProperties`: see the module header for why tolerance stops
    // where preservation stops.
    const nested = child.properties;
    if (isPlainObject(nested)) relaxIn(nested, here, leaves);
  }
}

/**
 * Stop the generated JSON Schema from refusing a value on a named scalar leaf.
 *
 * Mutates the schema in place, exactly as `tolerateUnknownKeys` does and for the
 * same reason: Ajv is the only validator on the config read path, and it runs
 * before DorkOS sees anything. Every relaxed leaf keeps its `default` and loses
 * every keyword that can reject — `type`, `enum`, `minimum`, `pattern`, all of
 * it — because the checking moves to {@link repairWidenedLeaves}.
 *
 * @param sections - The per-top-level-key schema map conf validates against,
 *   mutated in place.
 * @returns The policy the read and write paths run on.
 */
export function relaxWidenedLeaves(sections: Record<string, unknown>): WidenedLeafPolicy {
  const leaves: RelaxedLeaf[] = [];
  relaxIn(sections, [], leaves);
  const paths = new Set<string>();
  const bySection = new Map<string, RelaxedLeaf[]>();
  for (const leaf of leaves) {
    paths.add(leaf.path);
    const existing = bySection.get(leaf.section);
    if (existing === undefined) bySection.set(leaf.section, [leaf]);
    else existing.push(leaf);
  }
  return { paths, bySection };
}

/** The value at a dot-path, or {@link MISSING} when the path does not exist. */
function valueAt(root: unknown, segments: readonly string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (!isPlainObject(node) || !(segment in node)) return MISSING;
    node = node[segment];
  }
  return node;
}

/** A copy of `root` with `value` written at a dot-path. */
function withPath(root: unknown, segments: readonly string[], value: unknown): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (!isPlainObject(root)) return root;
  return { ...root, [head]: withPath(root[head], rest, value) };
}

/** No relaxed leaf lives here — shared so the common path allocates nothing. */
const NO_RELAXED: readonly RelaxedLeaf[] = [];

/**
 * The relaxed leaves at or under a config path.
 *
 * @param path - A top-level section, a dot-path into one, or a leaf itself.
 * @param policy - What {@link relaxWidenedLeaves} opened.
 */
function leavesUnder(path: string, policy: WidenedLeafPolicy): readonly RelaxedLeaf[] {
  const section = path.split('.')[0]!;
  const candidates = policy.bySection.get(section);
  if (candidates === undefined) return NO_RELAXED;
  if (path === section) return candidates;
  return candidates.filter((leaf) => leaf.path === path || leaf.path.startsWith(`${path}.`));
}

/** A leaf's path relative to the value being read, e.g. `['codex','defaultModel']`. */
function relativeSegments(path: string, leafPath: string): readonly string[] {
  return leafPath === path ? [] : leafPath.slice(path.length + 1).split('.');
}

/**
 * Fall back to the schema default on any leaf whose stored value this build
 * cannot interpret.
 *
 * Each relaxed leaf is checked against its OWN Zod field — the authoritative
 * schema, and the only thing still guarding those positions now that
 * {@link relaxWidenedLeaves} has taken them away from Ajv. A leaf Zod refuses is
 * replaced by its own default and nothing else is touched, so an unrecognized
 * key beside it survives in memory as well as on disk, and a failure the schema
 * has elsewhere cannot suppress the repair.
 *
 * Per leaf rather than per section for a reason worth keeping: parsing the whole
 * `ui` section on every read cost 230µs, six times what reading it cost in the
 * first place, and this accessor is called several times per request.
 *
 * `path` may be a section, a dot-path into one, or a leaf itself — one function
 * for `get`, `getAll`, `getDot` and the write path, so all four agree about what
 * a value means. A path naming nothing relaxed comes back untouched, which is
 * also what keeps `dorkos config get 'workbench.defaultViewers.a\.tex'` honest:
 * an escaped dot can only address a RECORD key, records hold no relaxed leaves,
 * and the value `conf`'s own dot-prop lookup returned is passed straight
 * through rather than re-navigated here.
 *
 * Returns its input by reference when there was nothing to repair.
 *
 * @param path - What is being read, as `conf` was asked for it.
 * @param value - The value `conf` handed over.
 * @param policy - What {@link relaxWidenedLeaves} opened. Nothing outside it is
 *   ever repaired, so a leaf Ajv still guards cannot be silently defaulted here
 *   instead.
 * @returns The value this build should run on, plus what it could not read.
 */
export function repairWidenedLeaves(
  path: string,
  value: unknown,
  policy: WidenedLeafPolicy
): { value: unknown; skewed: readonly WidenedLeaf[] } {
  const leaves = leavesUnder(path, policy);

  let repaired: unknown = value;
  let skewed: WidenedLeaf[] | undefined;
  for (const leaf of leaves) {
    const relative = relativeSegments(path, leaf.path);
    const stored = relative.length === 0 ? value : valueAt(value, relative);
    // Absent is not skew: conf's Ajv has already written the default in, and a
    // leaf nested under a section whose SHAPE is wrong never gets this far —
    // Ajv condemns that file before DorkOS is handed anything.
    if (stored === MISSING) continue;
    // The fast path, and it is the common one: `conf` materializes every
    // default to disk, so most leaves in most files hold exactly the value this
    // build would fall back to. A leaf already sitting on its own default cannot
    // be one another build widened, and skipping Zod there is what keeps this
    // off the cost of a read. Sound because both sides are scalars.
    if (stored === leaf.fallback) continue;
    if (leaf.schema.safeParse(stored).success) continue;
    skewed ??= [];
    skewed.push({ path: leaf.path, stored, used: leaf.fallback });
    repaired = relative.length === 0 ? leaf.fallback : withPath(repaired, relative, leaf.fallback);
  }

  if (skewed === undefined) return { value, skewed: NO_LEAVES };
  return { value: repaired, skewed };
}

/**
 * Carry a value this build could not read back onto the write that is about to
 * replace it.
 *
 * Tolerating a widened value on the way IN is only half of it, exactly as it was
 * for an unrecognized key. This build read `ui.theme` as `'system'` because
 * `'midnight'` meant nothing to it; the next time anything saves the `ui`
 * section it saves `'system'`, and the person's real choice is gone from the
 * file — the same loss as a wipe, arriving one preference at a time.
 *
 * **The test is EQUALITY, not absence.** A write that carries back exactly the
 * value this build handed out is a write that never knew about the stored one,
 * so the stored one survives; a write carrying anything else is somebody
 * choosing, and choosing wins. Say it that way rather than "a write that did not
 * name the leaf", because the two come apart: a PARTIAL write that omits the
 * leaf entirely is not carried, and the stored value goes. That is deliberate —
 * an absent key is what deleting a setting looks like, and `preserveUnknownKeys`
 * makes the same call for the same reason — but every caller in DorkOS writes a
 * Zod-parsed section, where every leaf is present.
 *
 * **The one case this gets wrong, stated plainly.** Deliberately setting the
 * leaf to the very value already on screen — picking `System` while the file
 * says `midnight`, which this build has been showing as `System` all along —
 * looks identical to not touching it, and the stored value survives. The person
 * sees no change either way, because there was none to see.
 *
 * @param skewed - What {@link repairWidenedLeaves} could not read, from the
 *   stored value at `keyPath`.
 * @param keyPath - The path being written: a top-level section, or a dot-path
 *   into one.
 * @param next - The value about to be stored.
 * @returns `next` unchanged when there is nothing to carry, otherwise a copy
 *   carrying the stored values.
 */
export function preserveWidenedLeaves(
  skewed: readonly WidenedLeaf[],
  keyPath: string,
  next: unknown
): unknown {
  if (skewed.length === 0) return next;
  let result = next;
  for (const leaf of skewed) {
    if (leaf.path !== keyPath && !leaf.path.startsWith(`${keyPath}.`)) continue;
    const rest = relativeSegments(keyPath, leaf.path);
    const written = rest.length === 0 ? result : valueAt(result, rest);
    if (written === MISSING) continue;
    if (!isDeepStrictEqual(written, leaf.used)) continue;
    result = rest.length === 0 ? leaf.stored : withPath(result, rest, leaf.stored);
  }
  return result;
}

/**
 * One line naming a setting this build could not read, for a log, a checklist
 * row, or `dorkos config validate`.
 *
 * **A stored value is redacted when its path is sensitive.** Four leaves hold
 * credentials (`SENSITIVE_CONFIG_KEYS`), they are all nullable strings with
 * defaults, and so they are all relaxed — which means a newer build changing how
 * a token is encoded would otherwise print that token into a log file the moment
 * an older build read it. The path and the fact of the skew are the whole point
 * of the message; the secret is not part of it.
 *
 * @param leaf - What {@link repairWidenedLeaves} could not read.
 * @returns e.g. `ui.theme: "midnight" (using "system")`.
 */
export function describeWidenedLeaf(leaf: WidenedLeaf): string {
  const sensitive = (SENSITIVE_CONFIG_KEYS as readonly string[]).includes(leaf.path);
  const stored = sensitive ? '<hidden>' : JSON.stringify(leaf.stored);
  return `${leaf.path}: ${stored} (using ${JSON.stringify(leaf.used)})`;
}
