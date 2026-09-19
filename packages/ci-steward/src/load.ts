/**
 * Loads `ci/config.yaml` and the hand files it names, validating each against
 * its schema. A file that fails becomes a finding, never an exception, so one
 * broken hand file cannot hide the problems in the others.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import type { Finding } from './finding.ts';
import {
  AllowlistSchema,
  ConfigSchema,
  GatesSchema,
  MetricsSchema,
  RatchetsSchema,
  RequiredChecksSchema,
  SlosSchema,
  StewardOwnedPathsSchema,
  describeZodError,
  type Allowlist,
  type Config,
  type Gates,
  type Metrics,
  type Ratchets,
  type RequiredChecks,
  type Slos,
  type StewardOwnedPaths,
} from './schemas.ts';

/** Where the engine's own config lives, relative to the repo root. */
export const CONFIG_PATH = 'ci/config.yaml';

/** Every hand file, parsed. A field is missing when that file failed to load. */
export interface HandFiles {
  config: Config;
  requiredChecks?: RequiredChecks;
  gates?: Gates;
  slos?: Slos;
  metrics?: Metrics;
  ratchets?: Ratchets;
  stewardOwnedPaths?: StewardOwnedPaths;
  allowlist?: Allowlist;
}

function readStructured(root: string, rel: string): unknown {
  const text = readFileSync(path.join(root, rel), 'utf8');
  return rel.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
}

function loadOne<S extends z.ZodType>(
  root: string,
  rel: string,
  schema: S,
  schemaName: string,
  findings: Finding[]
): z.infer<S> | undefined {
  if (!existsSync(path.join(root, rel))) {
    findings.push({
      code: 'schema/missing-file',
      file: rel,
      message: `The hand file ${rel} does not exist, and the CI Steward reads it.`,
      fix: `Create ${rel} (its shape is ${schemaName} in packages/ci-steward/src/schemas.ts), or point ci/config.yaml at where it moved.`,
    });
    return undefined;
  }
  let raw: unknown;
  try {
    raw = readStructured(root, rel);
  } catch (e) {
    findings.push({
      code: 'schema/parse',
      file: rel,
      message: `${rel} does not parse: ${e instanceof Error ? e.message : String(e)}`,
      fix: `Fix the ${rel.endsWith('.json') ? 'JSON' : 'YAML'} syntax at the position named above.`,
    });
    return undefined;
  }
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  findings.push({
    code: 'schema/invalid',
    file: rel,
    message: `${rel} does not match its schema: ${describeZodError(result.error).join('; ')}`,
    fix: `Edit ${rel} so each field named above matches ${schemaName} in packages/ci-steward/src/schemas.ts.`,
  });
  return undefined;
}

/**
 * Load and validate the config and every hand file.
 *
 * @param root - Repo root.
 * @returns The files that loaded, or no config at all when `ci/config.yaml` itself failed, plus the findings.
 */
export function loadHandFiles(root: string): { files?: HandFiles; findings: Finding[] } {
  const findings: Finding[] = [];
  const config = loadOne(root, CONFIG_PATH, ConfigSchema, 'ConfigSchema', findings);
  if (!config) return { findings };
  const h = config.hand_files;
  const files: HandFiles = {
    config,
    requiredChecks: loadOne(
      root,
      h.required_checks,
      RequiredChecksSchema,
      'RequiredChecksSchema',
      findings
    ),
    gates: loadOne(root, h.gates, GatesSchema, 'GatesSchema', findings),
    slos: loadOne(root, h.slos, SlosSchema, 'SlosSchema', findings),
    metrics: loadOne(root, h.metrics, MetricsSchema, 'MetricsSchema', findings),
    ratchets: loadOne(root, h.ratchets, RatchetsSchema, 'RatchetsSchema', findings),
    stewardOwnedPaths: loadOne(
      root,
      h.steward_owned_paths,
      StewardOwnedPathsSchema,
      'StewardOwnedPathsSchema',
      findings
    ),
    allowlist: loadOne(root, h.census_allowlist, AllowlistSchema, 'AllowlistSchema', findings),
  };
  return { files, findings };
}
