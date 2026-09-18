/**
 * The catalog-blindness guard.
 *
 * THE RULE, stated the way it actually binds: **no published type or type
 * metadata may carry a catalog value.** `z.enum` is only the most obvious shape
 * it can take. All of these publish the ladder identically, and a check that
 * only looks for `z.enum` passes every one of them:
 *
 *   - `z.union([z.literal('…'), z.literal('…')])`
 *   - `z.nativeEnum(SomeEnum)`
 *   - a hand-written TypeScript string-literal union
 *   - a `const` array of identifiers a schema is derived from
 *   - `.describe('one of: …')`, `.default('…')`, or an `@example` tag
 *
 * WHY IT MATTERS HERE AND NOT ELSEWHERE. This package publishes to public npm.
 * A `.d.ts` that enumerates the subscription ladder or the routed-model catalog
 * publishes both, permanently and in a form nothing can walk back — and read
 * beside the published price list, a model enumeration says more than the list
 * does. A *value* a caller happens to be on is fine; the *set* is not.
 *
 * WHAT IS NOT A VIOLATION. Enums that describe mechanism: the `Problem` codes,
 * the remote `mode`/`state` pair, the entitlement capability enums
 * (`remoteAccess`, `customAddress`, `support`), the `supports` booleans, the
 * refusal reasons, `groupBy`, the RFC 8628 error set. Each says how the thing
 * works, not what anybody bought, and each named one is listed in
 * MECHANISM_ENUMS below with its reason, so adding a new one is a deliberate
 * edit rather than a silent widening. "Exports an enum" reads through a union,
 * because a union is how a named export would otherwise publish a set of
 * literals without ever being asked to justify them.
 *
 * HOW THIS FILE CHECKS IT, in three layers:
 *
 *   1. A runtime walk of every exported schema. Any field whose NAME is
 *      catalog-shaped must resolve to a plain string node — never an enum, a
 *      literal, a union of literals, or a native enum. This is the layer that
 *      catches a well-meaning refactor.
 *   2. A scan of the EMITTED `.d.ts`, compiled in-process from the emit program
 *      so the check cannot drift from what actually ships. A catalog-shaped
 *      property whose emitted type is anything but `string` fails here even if
 *      layer 1 could not reach it.
 *   3. An optional literal scan against the real catalog values, which cannot
 *      live in this repository. It reads them from
 *      `DORKOS_CATALOG_BLINDNESS_VALUES` (comma-separated) and, when that is
 *      set, asserts the list is non-empty before it runs — so a missing list
 *      fails loudly rather than passing everything. Unset, the case is skipped
 *      with a name that says so; the control plane runs it with the list.
 */
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contract from '../index.js';

const packageRoot = path.resolve(import.meta.dirname, '..', '..');

/**
 * The words that name something from a catalog we sell or route to.
 *
 * Deliberately broader than the fields that exist today: a field added later
 * called `tierId` or `packageSku` is caught on arrival rather than when
 * somebody remembers this file.
 */
const CATALOG_WORDS = [
  'plan',
  'sku',
  'tier',
  'rung',
  'addon',
  'add_on',
  'model',
  'package',
  'catalog',
  'subscription',
];

/**
 * Whether a name contains a catalog WORD, as opposed to merely containing its
 * letters.
 *
 * Word-level rather than substring, and the difference is the whole guard. An
 * earlier version anchored the word to position zero, so `planId` matched while
 * `suggestedPlanId` and `requiredPlanId` — both of which are in this package —
 * did not. The obvious repair, a case-insensitive regex with a `[A-Z_]`
 * boundary, is worse: `/i` applies to the character class too, so `[A-Z_]`
 * quietly matches a lowercase letter and `planetName`, `supplanted` and
 * `modelling` all become catalog fields. Splitting the name into its words
 * settles both directions at once.
 *
 * @param name - A field name, or a dotted path through the schema tree.
 */
function isCatalogName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(
    (word) => CATALOG_WORDS.includes(word) || CATALOG_WORDS.includes(word.replace(/s$/, ''))
  );
}

/**
 * Names {@link isCatalogName} MUST recognise, and names it must NOT.
 *
 * This is the positive control. Every layer below gates on that one function,
 * so a hole in it is a hole in the whole guard — and a guard with no positive
 * control reports "clean" about exactly the fields it can no longer see. Both
 * lists are drawn from real mistakes: the first from an earlier version that
 * anchored the catalog word to position zero, the second from its repair, which
 * matched `planetName` and `modelling`.
 */
const CATALOG_NAME_CONTROL = {
  matches: [
    'planId',
    'suggestedPlanId',
    'requiredPlanId',
    'planDisplayName',
    'suggestedPlanDisplayName',
    'skuId',
    'modelId',
    'defaultModelId',
    'preferredModel',
    'routedModel',
    'catalogVersion',
    'currentTier',
    'entitlementSku',
    'subscriptionPlanId',
    'addonKind',
    'seatAddons',
    'models',
    'addons',
  ],
  doesNotMatch: [
    'displayName',
    'instanceId',
    'seatId',
    'orgId',
    'handle',
    'status',
    'remoteAccess',
    'supplanted',
    'planetName',
    'modelling',
  ],
};

/**
 * Every enum this package exports under its own name, with the one-line reason
 * it is mechanism rather than catalog.
 *
 * A new exported enum fails the test below until somebody writes its reason
 * here. That is the point: the question "is this mechanism or is this catalog?"
 * has to be answered by a person, once, in writing — a machine cannot tell
 * `'priority'` from a subscription tier by looking at it.
 */
const MECHANISM_ENUMS: Record<string, string> = {
  ProblemCodeSchema: 'failure codes describe the protocol, not what anybody bought',
  ScopeSchema: 'scopes are abilities the protocol defines',
  AuthenticationKindSchema: 'which authentication flow to run; names no vendor',
  ConnectionStatusSchema: 'the lifecycle of a connection',
  RemoteAccessCapabilitySchema: 'how the tunnel behaves, not what was bought',
  CustomAddressCapabilitySchema: 'whether the mechanism is available, not its price',
  SupportCapabilitySchema: 'which channel, not which subscription',
  CostBasisSchema: 'where a price came from, not what the price is',
  UsageStateSchema: 'how a credit or subscription position reads at a glance',
  UsageGroupBySchema: 'how to group a query',
  InferenceRefusalReasonSchema: 'conditions a caller can act on',
  OrgKindSchema: 'personal or shared; a structural fact',
  MemberRoleSchema: 'what a member may do',
  InvitationStatusSchema: 'how far an invitation has got',
  SeatKindSchema: 'whether a seat holds a person or an agent',
  SeatStatusSchema: 'where a seat is in its lifecycle',
  AddressStatusSchema: 'whether an address is live or has been retired',
  InboxSourceKindSchema: 'where an item arrived from',
  PresenceStateSchema: 'how reachable a seat is',
  RemoteModeSchema: 'how remote access is arranged',
  RemoteStateSchema: 'where the tunnel is in its lifecycle',
  CustomAddressStatusSchema: 'where a hostname is in its setup',
  CertificateStateSchema: 'where a certificate is in its issuance',
  RemoteCommandOutcomeSchema: 'what an instance did with a command it leased',
};

/**
 * Leaf names that mean "the identifier of the thing this path is about".
 *
 * `AddonSchema.kind` is an add-on identifier, and the leaf name `kind` says
 * nothing about that. So for these leaves the whole dotted path is tested
 * instead, which is where the catalog word lives.
 */
const IDENTIFIER_LEAF = /^(id|ids|kind|kinds|ref|refs|slug|key)$/i;

/** Whether a schema node is, at its core, a plain string. */
function isPlainString(node: z.ZodTypeAny): boolean {
  const def = (node as unknown as { def: { type: string } }).def;
  return def.type === 'string';
}

/** Whether a schema node is an enum, a literal, or a union made only of literals. */
function isEnumeration(node: z.ZodTypeAny): boolean {
  const def = (node as unknown as { def: { type: string; options?: z.ZodTypeAny[] } }).def;
  if (def.type === 'enum' || def.type === 'literal') return true;
  if (def.type === 'union' && Array.isArray(def.options)) {
    return def.options.every((option) => {
      const optionDef = (option as unknown as { def: { type: string } }).def;
      return optionDef.type === 'literal';
    });
  }
  return false;
}

/** Strips the wrappers that sit between a field and the type it really is. */
function unwrap(node: z.ZodTypeAny): z.ZodTypeAny {
  let current = node;
  for (let i = 0; i < 50; i += 1) {
    const def = (current as unknown as { def: { type: string; innerType?: z.ZodTypeAny } }).def;
    if (
      (def.type === 'optional' ||
        def.type === 'nullable' ||
        def.type === 'default' ||
        def.type === 'readonly' ||
        def.type === 'catch' ||
        def.type === 'nonoptional') &&
      def.innerType
    ) {
      current = def.innerType;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Whether an exported schema publishes a set of literals under its own name.
 *
 * Looks one level into a union, and that is the whole point of it. `unwrap`
 * reaches through `optional`, `nullable` and the rest, but never into a union's
 * options — so `z.union([z.enum(['a', 'b']), z.string()])` publishes two
 * literals under an export name and sails past a filter that only reads the top
 * node. A union is the most natural shape an enum takes when somebody widens
 * it, which makes it the one shape this registry could least afford to miss.
 *
 * It reuses {@link isEnumeration}, so a union of bare literals — the first shape
 * the header of this file names — counts as well as a union containing an enum.
 *
 * One level is the deliberate limit, and it reaches slightly further than that
 * sounds: a union of bare literals nested inside a union is caught anyway,
 * because {@link isEnumeration} handles literal-unions itself. What still dodges
 * is a union containing a union containing an ENUM. The answer to that is not
 * more recursion: nothing in this package has any reason to publish one, and a
 * reviewer who meets one should ask why rather than trust a guard to have
 * walked it.
 *
 * @param schema - An exported schema.
 */
function publishesEnum(schema: z.ZodTypeAny): boolean {
  const core = unwrap(schema);
  const def = (core as unknown as { def: { type: string; options?: z.ZodTypeAny[] } }).def;
  if (def.type === 'enum') return true;
  if (def.type === 'union' && Array.isArray(def.options)) {
    return def.options.some((option) => isEnumeration(unwrap(option)));
  }
  return false;
}

/** One node found by the walk, with the dotted path that reached it. */
interface Visited {
  path: string;
  node: z.ZodTypeAny;
}

/**
 * Walks every reachable node of a schema tree.
 *
 * @param root - The schema to walk.
 * @param rootPath - The name to report the root as.
 */
function walk(root: z.ZodTypeAny, rootPath: string): Visited[] {
  const found: Visited[] = [];
  const seen = new Set<unknown>();

  /**
   * Visits one node and everything under it.
   *
   * @param node - The node to visit.
   * @param at - The dotted path that reached it.
   */
  function visit(node: z.ZodTypeAny, at: string): void {
    if (node == null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    found.push({ path: at, node });

    const def = (node as unknown as Record<string, unknown>).def as
      Record<string, unknown> | undefined;
    if (!def) return;

    const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
    if (shape) {
      for (const [key, value] of Object.entries(shape)) visit(value, `${at}.${key}`);
    }
    for (const key of ['innerType', 'element', 'valueType', 'keyType'] as const) {
      const child = def[key] as z.ZodTypeAny | undefined;
      if (child) visit(child, at);
    }
    const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny> | undefined;
    if (Array.isArray(options)) {
      options.forEach((option, index) => visit(option, `${at}[${index}]`));
    } else if (options instanceof Map) {
      for (const option of options.values()) visit(option, at);
    }
  }

  visit(root, rootPath);
  return found;
}

/** Every exported Zod schema of the root entry point, keyed by export name. */
function exportedSchemas(): Array<[string, z.ZodTypeAny]> {
  const found: Array<[string, z.ZodTypeAny]> = [];
  for (const [name, value] of Object.entries(contract) as Array<[string, unknown]>) {
    if (value instanceof z.ZodType) found.push([name, value as z.ZodTypeAny]);
  }
  return found;
}

/** The last segment of a dotted path, i.e. the field name. */
function fieldName(dotted: string): string {
  const segment = dotted.split('.').pop() ?? dotted;
  return segment.replace(/\[\d+]$/, '');
}

/**
 * Whether a node at this dotted path names something from a catalog.
 *
 * @param dotted - The dotted path the walk reached the node by.
 */
function isCatalogShaped(dotted: string): boolean {
  const field = fieldName(dotted);
  if (isCatalogName(field)) return true;
  return IDENTIFIER_LEAF.test(field) && isCatalogName(dotted);
}

describe('catalog blindness: the guard itself', () => {
  it('recognises every catalog-shaped name it is meant to, and no innocent one', () => {
    // The positive control. Without it, narrowing this regex by accident makes
    // every layer below report "clean" about fields it can no longer see — which
    // is exactly what an earlier version of it did to `suggestedPlanId` and
    // `requiredPlanId`, both of which are in this package.
    const missed = CATALOG_NAME_CONTROL.matches.filter((name) => !isCatalogName(name));
    expect(missed, 'these catalog-shaped names are invisible to the guard').toEqual([]);

    const overreach = CATALOG_NAME_CONTROL.doesNotMatch.filter((name) => isCatalogName(name));
    expect(overreach, 'these innocent names are being treated as catalog').toEqual([]);
  });

  it('reads an identifier leaf through its path, so `AddonSchema.kind` is caught', () => {
    expect(isCatalogShaped('AddonSchema.kind')).toBe(true);
    expect(isCatalogShaped('InferenceModelSchema.id')).toBe(true);
    expect(isCatalogShaped('SeatAssignRequestSchema.subject.kind')).toBe(false);
  });
});

describe('catalog blindness: the runtime schema tree', () => {
  it('exports schemas at all, so a broken import cannot make this file vacuous', () => {
    expect(exportedSchemas().length).toBeGreaterThan(40);
  });

  it('never enumerates a catalog-shaped identifier', () => {
    const offenders: string[] = [];
    for (const [name, schema] of exportedSchemas()) {
      for (const { path: at, node } of walk(schema, name)) {
        if (!isCatalogShaped(at)) continue;
        const core = unwrap(node);
        const kind = (core as unknown as { def: { type: string } }).def.type;
        // A COLLECTION named after a catalog — `models`, `addons` — is not
        // itself an identifier; its elements are checked on their own paths.
        if (kind === 'object' || kind === 'array' || kind === 'record' || kind === 'unknown')
          continue;
        if (isEnumeration(core) || !isPlainString(core)) {
          offenders.push(`${at} is a ${kind}, and a catalog-shaped field must be a plain string`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every enum it exports under its own name a written mechanism reason', () => {
    // A named exported enum is the shape a catalog leak would most plausibly
    // take, and it is the shape a person can be asked about. Anything new here
    // stays red until somebody writes down why it is mechanism.
    const exportedEnums = exportedSchemas()
      .filter(([, schema]) => publishesEnum(schema))
      .map(([name]) => name)
      .sort();

    expect(exportedEnums).toEqual(Object.keys(MECHANISM_ENUMS).sort());
    for (const [name, reason] of Object.entries(MECHANISM_ENUMS)) {
      expect(reason.length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(15);
    }
  });

  it('carries no catalog value in any description or default', () => {
    // A description that spells out a ladder publishes it as surely as an enum
    // does, and `.describe()` reaches the generated JSON Schema as well as the
    // `.d.ts`. Two rules, and the second is the one an earlier version of this
    // file was missing: "one of: a, b" is the obvious shape, but
    // `.describe('e.g. "the-annual-one"')` publishes exactly as much.
    const offenders: string[] = [];
    for (const [name, schema] of exportedSchemas()) {
      for (const { path: at, node } of walk(schema, name)) {
        const description = (node as { description?: string }).description;
        if (description) {
          if (/\b(one of|such as|e\.?g\.?|for example|values?\s*:)/i.test(description)) {
            offenders.push(`${at} describes example or enumerated values: ${description}`);
          }
          // A quoted token in a description on a catalog-shaped field is a
          // value, whatever the sentence around it claims. Backticks are
          // excluded: TSDoc uses them to name a sibling FIELD (`requiredPlanId`),
          // which is a reference to this contract, not a value from a catalog.
          if (isCatalogShaped(at) && /["'][^"']+["']/.test(description)) {
            offenders.push(`${at} quotes a value in its description: ${description}`);
          }
        }
        const def = (node as unknown as { def: { type: string } }).def;
        if (def.type === 'default' && isCatalogShaped(at)) {
          offenders.push(`${at} carries a default for a catalog-shaped field`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no field counting local agents, anywhere', () => {
    // Local agents are free and unlimited and no cloud surface counts them. The
    // absence is the contract, which is why it has a test.
    const offenders: string[] = [];
    for (const [name, schema] of exportedSchemas()) {
      for (const { path: at } of walk(schema, name)) {
        if (/local.?agent/i.test(fieldName(at))) offenders.push(at);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Memoized so the one compile is shared by every case that reads it. */
let emittedOnce: Map<string, string> | undefined;

/** The emitted declarations, compiled once per run. */
function emitDeclarations(): Map<string, string> {
  emittedOnce ??= compileDeclarations();
  return emittedOnce;
}

/** Compiles the emit program in memory and returns every emitted `.d.ts`. */
function compileDeclarations(): Map<string, string> {
  const configPath = path.join(packageRoot, 'tsconfig.build.json');
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(raw.error, `tsconfig.build.json did not parse`).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, packageRoot);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    declarationMap: false,
  });
  const emitted = new Map<string, string>();
  const result = program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith('.d.ts')) emitted.set(fileName, text);
  });
  expect(result.emitSkipped, 'declaration emit was skipped').toBe(false);
  return emitted;
}

describe('catalog blindness: the emitted declarations', () => {
  const emitted = emitDeclarations();
  const allText = [...emitted.values()].join('\n');

  it('emits declarations for the whole public surface', () => {
    expect(emitted.size).toBeGreaterThan(5);
    expect(allText).toContain('EntitlementsSchema');
    expect(allText).toContain('InferenceModelSchema');
  });

  it('types every catalog-shaped property as a plain string', () => {
    // Reads the emitted types rather than the source, because the emitted types
    // are what npm ships and what a consumer's editor completes from. What is
    // emitted is the Zod node type (`z.ZodString`, `z.ZodEnum<…>`), so the
    // acceptance is written against those spellings rather than against
    // `string`.
    const offenders: string[] = [];
    const property = /^\s*(readonly\s+)?([A-Za-z_$][\w$]*)\??:\s*(.+?);?\s*$/;
    for (const [file, text] of emitted) {
      for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/,\s*$/, '');
        const match = property.exec(line);
        if (!match) continue;
        const [, , name, rawType] = match;
        if (!isCatalogName(name)) continue;
        const type = rawType.replace(/[;,]$/, '').trim();

        // An enum's own member map emits as `none: "none"`. That is the inside
        // of a mechanism enum (which MECHANISM_ENUMS vouches for by name), not
        // a field whose value came from a catalog.
        if (type === `"${name}"`) continue;

        // The route table. `connectionsCatalog: "/v1/connections/catalog"` is a
        // PATH this contract serves, which is published on purpose — the whole
        // file exists to publish them — and a path is not a catalog value.
        if (/^"\/v1\//.test(type)) continue;

        // A route builder, e.g. `seatAddon: (seatId: string, kind: string) => string`.
        // Its parameters are already `string`; there is no catalog value a
        // function signature could carry.
        if (/=>\s*string$/.test(type)) continue;

        // Strip the wrappers that can sit between a field and its real type.
        let core = type;
        for (let i = 0; i < 10; i += 1) {
          const unwrapped = /^z\.Zod(Optional|Nullable|Default|ReadOnly|NonOptional)<(.+)>$/.exec(
            core
          );
          if (!unwrapped) break;
          core = unwrapped[2].trim();
        }
        if (core === 'z.ZodString' || core === 'string') continue;
        // A collection named after a catalog is not itself an identifier; its
        // element properties are matched on their own lines.
        if (/^z\.Zod(Array|Object|Record)</.test(core)) continue;

        offenders.push(`${path.basename(file)}: ${name}: ${type}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no hand-written type alias that enumerates anything', () => {
    // The shape the property scan above cannot see: `export type PlanId = 'a' |
    // 'b'` has no `name:` colon, so it slips past a property-shaped check while
    // publishing the ladder just as completely. Rather than special-case the
    // catalog-shaped ones, no published alias may be a union of string literals
    // at all — this package has no legitimate use for one (every enumeration it
    // does publish comes from a Zod schema, which MECHANISM_ENUMS vouches for),
    // so a blanket refusal costs nothing and cannot be dodged by naming.
    const offenders: string[] = [];
    const alias = /^\s*(export\s+)?(declare\s+)?type\s+([A-Za-z_$][\w$]*)[^=]*=\s*(.+?);?\s*$/;
    for (const [file, text] of emitted) {
      for (const line of text.split('\n')) {
        const match = alias.exec(line);
        if (!match) continue;
        const [, , , name, body] = match;
        if (/^(["'][^"']*["']\s*\|\s*)+["'][^"']*["']$/.test(body.trim())) {
          offenders.push(`${path.basename(file)}: type ${name} = ${body.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('writes no number into a doc comment, because a threshold is a number', () => {
    // The catalog rule's quieter sibling. This package deliberately names the
    // REFUSAL a threshold produces — `topup_below_minimum`, `first_purchase_cap`,
    // `refund_window_closed`, `daily_limit_reached` — because a person has to be
    // told what happened. The threshold itself is server policy and belongs
    // nowhere here.
    //
    // A `.describe()` is not where that would leak. TSDoc is: it is prose,
    // nobody writes a test against prose, and it is emitted into the `.d.ts`
    // this package publishes to public npm.
    //
    // So the rule is the blunt one rather than a list of English words. An
    // earlier version of this case looked for a policy word near a digit, and it
    // was worse than useless in both directions: Prettier wraps these comments
    // at 80 columns, so "The refund window is" and "30 days" land on different
    // lines and no same-line pattern can see them — while `cap` inside
    // "capability" and `rate` inside "enumerate" made ordinary prose a
    // liability. A threshold is a NUMBER, wrapped or not, spelled however the
    // author likes. The whole emitted surface carries six digits today, and
    // every one of them is in the list below with its reason, which is the same
    // bargain MECHANISM_ENUMS strikes: the exception is cheap, and a person
    // writes it down.
    const allowed: Array<[RegExp, string]> = [
      [/^\s*\*\s*\d+\.\s/, 'an ordered-list marker in a doc comment'],
      [/\/v\d+/g, 'the wire version in a route path'],
      [/\d+\^\d+/g, 'an exponent, e.g. the precision limit of a float'],
      [/\b(iso|rfc|utf|http)-?\s?\d+/gi, 'a standards reference'],
      [/base-\d+/gi, 'the base a number is written in, as in base-10'],
      [/X-DorkOS-Wire: \d+/g, 'this contract`s own header value'],
      [/\b[1-5]\d{2}\b/g, 'an HTTP status code'],
      [/\b\d{1,2}(st|nd|rd|th)\b/gi, 'a day of the month'],
      [/\b\d{1,2}-day\b/gi, 'a length of a calendar month'],
    ];

    const offenders: string[] = [];
    for (const [file, text] of emitted) {
      for (const [index, line] of text.split('\n').entries()) {
        if (!/^\s*(\/\*\*|\*)/.test(line)) continue;
        let rest = line;
        for (const [pattern] of allowed) rest = rest.replace(pattern, ' ');
        if (/\d/.test(rest)) offenders.push(`${path.basename(file)}:${index + 1} ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
    // The allowlist is the precision, so it has to stay a list somebody reads.
    for (const [pattern, reason] of allowed) {
      expect(reason.length, `${pattern} needs a real reason, not a placeholder`).toBeGreaterThan(
        15
      );
    }
  });

  it('carries no @example tag, which would publish a value in a comment', () => {
    // TSDoc comments are emitted into the `.d.ts`, so ` * @example "the-annual-one"`
    // ships a catalog value with no type node anywhere for a structural check to
    // find. This package documents by prose and by fixtures instead, so the tag
    // is simply banned rather than inspected.
    const offenders: string[] = [];
    for (const [file, text] of emitted) {
      for (const [index, line] of text.split('\n').entries()) {
        if (/@example\b/.test(line)) offenders.push(`${path.basename(file)}:${index + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no provider or vendor in the inference surface', () => {
    // Which provider serves a request is not part of this contract. The two
    // wire-format field names below are the sole carve-out: they name a REQUEST
    // FORMAT a caller encodes in, not a supplier we route to, and a client has
    // to know which format an endpoint speaks.
    const inference = [...emitted.entries()].find(([file]) => file.endsWith('inference.d.ts'));
    expect(inference, 'inference.d.ts was not emitted').toBeDefined();
    const text = (inference as [string, string])[1]
      .replace(/anthropicMessages/g, '')
      .replace(/openaiChat/g, '');
    for (const vendor of ['anthropic', 'openai', 'google', 'bedrock', 'vertex', 'azure', 'aws']) {
      expect(
        text.toLowerCase(),
        `"${vendor}" appears in the emitted inference types`
      ).not.toContain(vendor);
    }
  });

  it('bakes in no host, origin or URL literal', () => {
    // Endpoints are runtime values. A URL literal in a published type is a
    // dependency on where the service happens to live today.
    // `.invalid` is reserved by RFC 2606 and resolves nowhere, so the example
    // hosts in the doc comments are not a dependency on anything.
    const urls = allText.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    const external = urls.filter((url) => !/^https?:\/\/[^/]*\.invalid(\/|$)/.test(url));
    expect(external).toEqual([]);
  });
});

/**
 * The real catalog values cannot live in this repository, so this layer runs
 * only where they are supplied. `it.skipIf` rather than a silent pass: the case
 * is reported as skipped with the variable named in its title.
 */
const supplied = (process.env.DORKOS_CATALOG_BLINDNESS_VALUES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

describe('catalog blindness: the literal scan', () => {
  it.skipIf(!process.env.DORKOS_CATALOG_BLINDNESS_VALUES)(
    'finds no supplied catalog value in the emitted declarations (set DORKOS_CATALOG_BLINDNESS_VALUES to run)',
    () => {
      // A set variable with nothing usable in it must fail rather than pass
      // everything: an empty list is the one way this check can silently stop
      // checking anything.
      expect(supplied.length, 'DORKOS_CATALOG_BLINDNESS_VALUES was set but empty').toBeGreaterThan(
        0
      );
      const text = [...emitDeclarations().values()].join('\n').toLowerCase();
      const found = supplied.filter((value) => text.includes(value.toLowerCase()));
      expect(found).toEqual([]);
    }
  );
});
