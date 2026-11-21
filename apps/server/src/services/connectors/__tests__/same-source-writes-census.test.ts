/**
 * Only a person can change what a prompt kind answers (DOR-4794, Security's case 5). A switch is
 * an agent raising its own power if anything an agent reaches can set it, so:
 *
 * - no capability in the whole composed registry, and no hand-registered MCP tool, takes an input
 *   that names the writes-back switch;
 * - its one writer, `setWritesBack`, is called from the operator-only route alone, and only the
 *   files listed here name the column at all, each with why;
 * - every route in that file asks `resolveConnectorOperator` first, which refuses agents,
 *   programs and approval tokens;
 * - every switch in the prompt-kind registry is one of those: a connection field with an
 *   operator-only writer listed here, or an operator-only config path;
 * - no floor kind (one that always asks) is a key in the config schema, where a setting could
 *   lower it.
 *
 * Adding a file or a kind here means an agent still can't reach the switch through it. Say why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { connections } from '@dorkos/db';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  PROMPT_KINDS,
  PROMPT_KIND_KEYS,
  type PromptKind,
} from '@dorkos/shared/prompts/prompt-kinds';
import { composeCapabilityRegistryForDocs } from '../../core/self-description/dorkos-registry.js';
import { MCP_TOOL_TIERS } from '../../core/mcp-tool-tiers.js';
import { serializeCapability } from '../../core/capabilities/registry.js';
import { OPERATOR_ONLY_CONFIG_PATHS } from '../../core/operator/config-write-policy.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one route file, and the one store, that may call the writer. */
const WRITER_FILES: Record<string, string> = {
  'services/connectors/access/writes-back-store.ts': 'defines setWritesBack',
  'routes/connector-writes-back.ts':
    'the operator-only route: resolveConnectorOperator, then a step-up to turn it on',
};

/** Files allowed to name the switch, each with why an agent can't set it through them. */
const NAMING_FILES: Record<string, string> = {
  ...WRITER_FILES,
  'services/connectors/execution/reaches-outside.ts':
    'the connector preflight reads the switch for a call it already authorized',
  'services/core/prompts/connector-gate-facts.ts':
    'carries what the preflight read to the permission gate; it writes nothing',
  'services/core/prompts/should-ask.ts': 'decides on what the preflight read; it writes nothing',
};

/**
 * Every connection-field switch, by its column, with its one writer and the files that may call
 * it. A connection switch missing here fails the registry test below.
 */
const OPERATOR_ONLY_CONNECTION_SWITCHES: Record<string, { writer: string; files: string[] }> = {
  writes_back_unasked: { writer: 'setWritesBack', files: Object.keys(WRITER_FILES) },
};

/** The kinds this census was last checked against; a new kind must be judged here first. */
const JUDGED_KINDS = ['connector.write.marked-same-source'];

/** The writer, called. */
const WRITER_CALL = /\bsetWritesBack\s*\(/;

/** The switch, by any name it goes by in code or SQL. */
const NAMES_THE_SWITCH = /\bwritesBackUnasked\b|\bwrites_back_unasked\b|\bwritesBackAttestedAt\b/;

/** An input key that would let a call carry the switch. */
const SWITCH_INPUT_KEY = /"(writes_?back\w*|writesBack\w*|confirmsNoOutsideSync)"\s*:/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Server source files, relative and sorted, whose text matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(SERVER_SRC)
    .filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SERVER_SRC, file).split(path.sep).join('/'))
    .sort();
}

/** Every key path in a Zod schema, as dot paths, through wrappers, objects, arrays and records. */
function configPaths(schema: z.ZodType, prefix = '', depth = 0): string[] {
  if (depth > 12) return [];
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const inner = (def.innerType ?? def.in ?? def.element ?? def.valueType) as z.ZodType | undefined;
  if (def.type === 'object') {
    const shape = def.shape as Record<string, z.ZodType>;
    return Object.entries(shape).flatMap(([key, child]) => {
      const here = prefix ? `${prefix}.${key}` : key;
      return [here, ...configPaths(child, here, depth + 1)];
    });
  }
  if (def.type === 'union') {
    return (def.options as z.ZodType[]).flatMap((option) => configPaths(option, prefix, depth + 1));
  }
  return inner ? configPaths(inner, prefix, depth + 1) : [];
}

describe('the writes-back switch is a person’s alone (DOR-4794)', () => {
  it('calls its writer only from the operator-only route', () => {
    expect(filesMatching(WRITER_CALL)).toEqual(Object.keys(WRITER_FILES).sort());
  });

  it('is named only in files that read it or are the operator-only route', () => {
    expect(filesMatching(NAMES_THE_SWITCH)).toEqual(Object.keys(NAMING_FILES).sort());
  });

  it('is in no capability input, in the whole composed registry', () => {
    const registry = composeCapabilityRegistryForDocs();
    expect(registry.capabilities.length).toBeGreaterThan(50);
    const carrying = registry.capabilities
      .filter((capability) =>
        SWITCH_INPUT_KEY.test(JSON.stringify(serializeCapability(capability).inputSchema))
      )
      .map((capability) => capability.id);
    expect(carrying).toEqual([]);
  });

  it('is no hand-registered MCP tool', () => {
    const named = Object.keys(MCP_TOOL_TIERS).filter((id) => /writes?_?back/i.test(id));
    expect(named).toEqual([]);
  });

  it('asks resolveConnectorOperator first on every route of the operator-only file', () => {
    const text = fs.readFileSync(path.join(SERVER_SRC, 'routes/connector-writes-back.ts'), 'utf8');
    const routes = text.match(/router\.(get|put|post|patch|delete)\(/g) ?? [];
    const owners = text.match(/const owner = resolveConnectorOperator\(c, deps\);/g) ?? [];
    expect(routes.length).toBeGreaterThan(0);
    expect(owners.length).toBe(routes.length);
  });
});

describe('the prompt-kind registry (DOR-4794)', () => {
  const kinds: PromptKind[] = PROMPT_KIND_KEYS.map((key) => PROMPT_KINDS[key]);

  // Red when a kind is added without being judged here, and so without its switch being checked.
  it('holds only the kinds this census has judged', () => {
    expect([...PROMPT_KIND_KEYS].sort()).toEqual([...JUDGED_KINDS].sort());
  });

  // Red when a switch appears that an agent could reach: a connection field with no listed
  // operator-only writer (or a writer called from anywhere else), or a config key an agent's
  // config patch may write.
  it('makes every switch unreachable by agents', () => {
    // A Drizzle table exposes each column as a property carrying its database name.
    const columns = Object.entries(connections as unknown as Record<string, unknown>).filter(
      (entry): entry is [string, { name: string }] =>
        typeof (entry[1] as { name?: unknown } | null)?.name === 'string'
    );
    for (const kind of kinds) {
      if (kind.floor || !kind.switch) continue;
      const sw = kind.switch;
      if (sw.store === 'config') {
        expect(OPERATOR_ONLY_CONFIG_PATHS, `${kind.key}: ${sw.key}`).toContain(sw.key);
        continue;
      }
      const column = columns.find(([, col]) => col.name === sw.field);
      expect(column, `${kind.key}: no connections column ${sw.field}`).toBeDefined();
      const guard = OPERATOR_ONLY_CONNECTION_SWITCHES[sw.field];
      expect(guard, `${kind.key}: ${sw.field} has no operator-only writer listed`).toBeDefined();
      const calls = filesMatching(new RegExp(`\\b${guard!.writer}\\s*\\(`));
      expect(calls).toEqual([...guard!.files].sort());
      const property = column![0];
      const naming = filesMatching(new RegExp(`\\b${property}\\b|\\b${sw.field}\\b`));
      expect(naming.filter((file) => !(file in NAMING_FILES))).toEqual([]);
    }
  });

  // Red when a floor kind's key (or its last segment) becomes a config key: a setting could then
  // lower what must always ask. The first assertion proves the walk reads the real schema.
  it('keeps every floor kind out of the config schema', () => {
    const paths = configPaths(UserConfigSchema);
    expect(paths).toContain('tunnel.enabled');
    const segments = new Set(paths.flatMap((p) => p.split('.')));
    const floors = kinds.filter((kind) => kind.floor);
    for (const kind of floors) {
      expect(paths, kind.key).not.toContain(kind.key);
      expect(segments.has(kind.key.split('.').at(-1)!), kind.key).toBe(false);
    }
  });

  it('refuses a switch on a floor kind, by its type', () => {
    // @ts-expect-error A floor kind always asks, so it may name no switch.
    const floor: PromptKind = {
      ...PROMPT_KINDS['connector.write.marked-same-source'],
      floor: true,
    };
    expect(floor.floor).toBe(true);
  });
});
