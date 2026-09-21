/**
 * Bounded Neon project creation and cleanup mutations.
 *
 * @module commands/community-deploy/neon-mutate
 */
import { z } from 'zod';
import {
  ExternalIdentifierSchema,
  ExternalLabelSchema,
  parseExternalJson,
} from './provider-contract.js';
import { ProviderMutationError, runProviderMutation } from './provider-mutation.js';
import type { NeonProject, NeonReadOptions } from './neon-read.js';

const NeonProjectSchema = z
  .object({
    id: ExternalIdentifierSchema,
    org_id: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    region_id: ExternalIdentifierSchema,
    pg_version: z.number().int().min(14).max(19),
  })
  .passthrough();
const NeonCreateEnvelopeSchema = z.object({ project: NeonProjectSchema }).strict();

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProviderMutationError('INVALID_INPUT');
  return result.data;
}

/** Create one project without allowing the Neon CLI to print connection credentials. */
export async function createNeonProject(
  options: NeonReadOptions,
  input: {
    organizationId: string;
    name: string;
    regionId: string;
    databaseName: string;
    roleName: string;
    postgresVersion: number;
  }
): Promise<NeonProject> {
  const organization = parseInput(ExternalIdentifierSchema, input.organizationId);
  const name = parseInput(ExternalLabelSchema, input.name);
  const region = parseInput(ExternalIdentifierSchema, input.regionId);
  const database = parseInput(ExternalLabelSchema, input.databaseName);
  const role = parseInput(ExternalLabelSchema, input.roleName);
  const version = parseInput(z.number().int().min(14).max(19), input.postgresVersion);
  const { project } = await runProviderMutation({
    ...options,
    args: [
      'projects',
      'create',
      '--name',
      name,
      '--org-id',
      organization,
      '--region-id',
      region,
      '--database',
      database,
      '--role',
      role,
      '--pg-version',
      String(version),
      '--no-secrets',
      '--output',
      'json',
    ],
    parse: (stdout) => {
      const parsed = NeonCreateEnvelopeSchema.parse(parseExternalJson(stdout));
      if (
        parsed.project.org_id !== organization ||
        parsed.project.name !== name ||
        parsed.project.region_id !== region ||
        parsed.project.pg_version !== version
      ) {
        throw new Error('PROJECT_BINDING_MISMATCH');
      }
      return parsed;
    },
  });
  return {
    id: project.id,
    organizationId: project.org_id,
    name: project.name,
    regionId: project.region_id,
    postgresVersion: project.pg_version,
  };
}

/** Delete one exact Neon project ID after cleanup has verified journal ownership. */
export async function deleteNeonProject(
  options: NeonReadOptions,
  projectId: string
): Promise<{ operation: 'delete'; projectId: string }> {
  const project = parseInput(ExternalIdentifierSchema, projectId);
  return runProviderMutation({
    ...options,
    args: ['projects', 'delete', project, '--output', 'json'],
    parse: () => ({ operation: 'delete' as const, projectId: project }),
  });
}

/** Refuse creation when the non-unique project label already exists in selected inventory. */
export function assertNeonProjectNameAvailable(
  projects: readonly NeonProject[],
  plannedName: string
): void {
  const name = parseInput(ExternalLabelSchema, plannedName);
  if (projects.some((project) => project.name === name)) {
    throw new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
  }
}
