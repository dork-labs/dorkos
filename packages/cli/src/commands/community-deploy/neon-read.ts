/**
 * Typed, read-only Neon preflight and topology inventory.
 *
 * @module commands/community-deploy/neon-read
 */
import { z } from 'zod';
import {
  ExternalIdentifierSchema,
  ExternalLabelSchema,
  parseExternalJson,
  requireUniqueExternalIds,
} from './provider-contract.js';
import { runProviderCommand } from './provider-process.js';

const NeonOrganizationSchema = z
  .object({ id: ExternalIdentifierSchema, name: ExternalLabelSchema })
  .passthrough();
const NeonProjectSchema = z
  .object({
    id: ExternalIdentifierSchema,
    org_id: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    region_id: ExternalIdentifierSchema,
    pg_version: z.number().int().positive(),
  })
  .passthrough();
const NeonBranchSchema = z
  .object({
    id: ExternalIdentifierSchema,
    project_id: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    default: z.boolean(),
  })
  .passthrough();
const NeonDatabaseSchema = z
  .object({
    id: ExternalIdentifierSchema,
    branch_id: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    owner_name: ExternalLabelSchema,
  })
  .passthrough();
const NeonRoleSchema = z
  .object({ branch_id: ExternalIdentifierSchema, name: ExternalLabelSchema })
  .passthrough();
const NeonCoordinateSchema = z.union([
  z.number().finite(),
  z.string().regex(/^-?(?:\d+(?:\.\d+)?|\.\d+)$/u),
]);
const NeonRegionSchema = z
  .object({
    region_id: ExternalIdentifierSchema,
    name: ExternalLabelSchema,
    default: z.boolean(),
    geo_lat: NeonCoordinateSchema,
    geo_long: NeonCoordinateSchema,
  })
  .passthrough();
const NeonRegionsEnvelopeSchema = z.object({ regions: z.array(NeonRegionSchema) }).passthrough();
const NeonEndpointSchema = z
  .object({
    id: ExternalIdentifierSchema,
    project_id: ExternalIdentifierSchema,
    branch_id: ExternalIdentifierSchema,
    region_id: ExternalIdentifierSchema,
    host: ExternalIdentifierSchema,
    type: z.enum(['read_write', 'read_only']),
  })
  .passthrough();
const NeonEndpointsEnvelopeSchema = z
  .object({ endpoints: z.array(NeonEndpointSchema) })
  .passthrough();

/** Options for one pinned Neon CLI read. */
export interface NeonReadOptions {
  /** Absolute or PATH-resolved Neon CLI executable. */
  executable: string;
  /** Minimal environment containing only Neon profile resolution inputs. */
  env: Readonly<Record<string, string>>;
  /** Command deadline in milliseconds. */
  timeoutMs: number;
}

/** Stable Neon organization selection candidate. */
export interface NeonOrganization {
  /** Provider-issued organization ID. */
  id: string;
  /** Human-readable organization name. */
  name: string;
}

/** Active Neon project region exposed by the authenticated API. */
export interface NeonRegion {
  /** Stable region ID accepted by project creation. */
  id: string;
  /** Human-readable region name. */
  name: string;
  /** Whether Neon marks this as the default region. */
  isDefault: boolean;
  /** Latitude when the provider exposes it. */
  latitude: number | null;
  /** Longitude when the provider exposes it. */
  longitude: number | null;
}

/** Non-secret Neon project identity. */
export interface NeonProject {
  /** Provider-issued project ID. */
  id: string;
  /** Provider-issued owning organization ID. */
  organizationId: string;
  /** Non-unique project label. */
  name: string;
  /** Provider region ID. */
  regionId: string;
  /** PostgreSQL major version. */
  postgresVersion: number;
}

/** Non-secret Neon branch identity. */
export interface NeonBranch {
  /** Provider-issued branch ID. */
  id: string;
  /** Provider-issued project ID. */
  projectId: string;
  /** Non-unique branch label. */
  name: string;
  /** Whether this is the project's default branch. */
  isDefault: boolean;
}

/** Database and role names bound to one exact Neon branch. */
export interface NeonBranchTopology {
  /** Validated databases in the branch. */
  databases: Array<{ id: string; branchId: string; name: string; ownerName: string }>;
  /** Validated roles in the branch. */
  roles: Array<{ branchId: string; name: string }>;
}

/** Non-secret identity read from a direct Neon connection URL. */
export interface NeonEndpointIdentity {
  /** Provider-issued endpoint ID parsed from the direct hostname. */
  id: string;
  /** Direct endpoint hostname without credentials. */
  host: string;
  /** Exact planned project ID. */
  projectId: string;
  /** Exact planned branch ID. */
  branchId: string;
  /** Exact database name. */
  databaseName: string;
  /** Exact role name. */
  roleName: string;
}

/** Provider endpoint inventory row used to bind the credential hostname to exact topology. */
export interface NeonEndpoint {
  /** Stable endpoint ID. */
  id: string;
  /** Exact project ID. */
  projectId: string;
  /** Exact branch ID. */
  branchId: string;
  /** Exact region ID. */
  regionId: string;
  /** Credential-free endpoint hostname. */
  host: string;
  /** Endpoint access posture. */
  type: 'read_write' | 'read_only';
}

/** Safe failure raised when a disposed Neon credential is reused. */
export class NeonCredentialError extends Error {
  /** Stable journal-safe failure code. */
  readonly code = 'CREDENTIAL_DISPOSED' as const;

  /** Create a credential lifecycle error without retaining credential material. */
  constructor() {
    super('Neon connection credential is no longer available');
    this.name = 'NeonCredentialError';
  }
}

/** In-memory direct PostgreSQL URL that redacts serialization and supports disposal. */
export class NeonConnectionCredential {
  #url: string | undefined;

  /** Wrap a validated direct TLS URL without exposing it as object data. */
  constructor(url: string) {
    this.#url = url;
  }

  /** Use the URL inside one bounded in-memory callback. */
  async use<T>(consumer: (url: string) => Promise<T>): Promise<T> {
    if (this.#url === undefined) throw new NeonCredentialError();
    return consumer(this.#url);
  }

  /** Drop this wrapper's reference to the connection URL. */
  dispose(): void {
    this.#url = undefined;
  }

  /** Return a safe marker for string interpolation. */
  toString(): string {
    return '[REDACTED Neon connection credential]';
  }

  /** Return a safe marker for JSON serialization. */
  toJSON(): string {
    return '[REDACTED Neon connection credential]';
  }
}

/** Sensitive direct URL plus the non-secret endpoint identity proven from it. */
export interface NeonDirectConnection {
  /** Non-secret endpoint and topology binding. */
  endpoint: NeonEndpointIdentity;
  /** Disposable sensitive URL wrapper. */
  credential: NeonConnectionCredential;
}

async function runNeonJson<T>(
  options: NeonReadOptions,
  args: readonly string[],
  schema: z.ZodType<T>,
  validate?: (value: T) => void
): Promise<T> {
  return (
    await runProviderCommand({
      ...options,
      args: [...args, '--output', 'json'],
      parse: (stdout) => {
        const parsed = schema.parse(parseExternalJson(stdout));
        validate?.(parsed);
        return parsed;
      },
    })
  ).value;
}

/** Read organizations; successful output is also the local authentication proof. */
export async function readNeonOrganizations(options: NeonReadOptions): Promise<NeonOrganization[]> {
  const organizations = await runNeonJson(
    options,
    ['orgs', 'list'],
    z.array(NeonOrganizationSchema),
    (values) => requireUniqueExternalIds(values, (organization) => organization.id)
  );
  return organizations.map(({ id, name }) => ({ id, name }));
}

/** Read the active region inventory through Neon's authenticated machine-readable API command. */
export async function readNeonRegions(options: NeonReadOptions): Promise<NeonRegion[]> {
  const result = (
    await runProviderCommand({
      ...options,
      args: ['api', '/regions', '--output', 'json'],
      parse: (stdout) => {
        const parsed = NeonRegionsEnvelopeSchema.parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed.regions, (region) => region.region_id);
        return parsed.regions;
      },
    })
  ).value;
  const coordinate = (value: string | number): number | null => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return result.map((region) => ({
    id: region.region_id,
    name: region.name,
    isDefault: region.default,
    latitude: coordinate(region.geo_lat),
    longitude: coordinate(region.geo_long),
  }));
}

/** Read projects only inside one explicitly selected organization. */
export async function readNeonProjects(
  options: NeonReadOptions,
  organizationId: string
): Promise<NeonProject[]> {
  const id = ExternalIdentifierSchema.parse(organizationId);
  const projects = await runNeonJson(
    options,
    ['projects', 'list', '--org-id', id],
    z.array(NeonProjectSchema),
    (values) => {
      requireUniqueExternalIds(values, (project) => project.id);
      if (values.some((project) => project.org_id !== id)) {
        throw new Error('ORGANIZATION_BINDING_MISMATCH');
      }
    }
  );
  return projects.map((project) => ({
    id: project.id,
    organizationId: project.org_id,
    name: project.name,
    regionId: project.region_id,
    postgresVersion: project.pg_version,
  }));
}

/** Read branches for one exact project ID without connection credentials. */
export async function readNeonBranches(
  options: NeonReadOptions,
  projectId: string
): Promise<NeonBranch[]> {
  const id = ExternalIdentifierSchema.parse(projectId);
  const branches = await runNeonJson(
    options,
    ['branches', 'list', '--project-id', id],
    z.array(NeonBranchSchema),
    (values) => {
      requireUniqueExternalIds(values, (branch) => branch.id);
      if (values.some((branch) => branch.project_id !== id)) {
        throw new Error('PROJECT_BINDING_MISMATCH');
      }
    }
  );
  return branches.map((branch) => ({
    id: branch.id,
    projectId: branch.project_id,
    name: branch.name,
    isDefault: branch.default,
  }));
}

/** Read database and role names for one exact project and branch identity. */
export async function readNeonBranchTopology(
  options: NeonReadOptions,
  projectId: string,
  branchId: string
): Promise<NeonBranchTopology> {
  const project = ExternalIdentifierSchema.parse(projectId);
  const branch = ExternalIdentifierSchema.parse(branchId);
  const common = ['--project-id', project, '--branch', branch] as const;
  const [databases, roles] = await Promise.all([
    runNeonJson(
      options,
      ['databases', 'list', ...common],
      z.array(NeonDatabaseSchema),
      (values) => {
        requireUniqueExternalIds(values, (database) => database.id);
        requireUniqueExternalIds(values, (database) => database.name);
        if (values.some((database) => database.branch_id !== branch)) {
          throw new Error('BRANCH_BINDING_MISMATCH');
        }
      }
    ),
    runNeonJson(options, ['roles', 'list', ...common], z.array(NeonRoleSchema), (values) => {
      requireUniqueExternalIds(values, (role) => role.name);
      if (values.some((role) => role.branch_id !== branch)) {
        throw new Error('BRANCH_BINDING_MISMATCH');
      }
    }),
  ]);
  return {
    databases: databases.map((database) => ({
      id: database.id,
      branchId: database.branch_id,
      name: database.name,
      ownerName: database.owner_name,
    })),
    roles: roles.map((role) => ({ branchId: role.branch_id, name: role.name })),
  };
}

/** Read exact endpoint identities for one project and branch. */
export async function readNeonEndpoints(
  options: NeonReadOptions,
  projectId: string,
  branchId: string
): Promise<NeonEndpoint[]> {
  const project = ExternalIdentifierSchema.parse(projectId);
  const branch = ExternalIdentifierSchema.parse(branchId);
  const result = (
    await runProviderCommand({
      ...options,
      args: ['api', `/projects/${project}/branches/${branch}/endpoints`, '--output', 'json'],
      parse: (stdout) => {
        const parsed = NeonEndpointsEnvelopeSchema.parse(parseExternalJson(stdout));
        requireUniqueExternalIds(parsed.endpoints, (endpoint) => endpoint.id);
        if (
          parsed.endpoints.some(
            (endpoint) => endpoint.project_id !== project || endpoint.branch_id !== branch
          )
        ) {
          throw new Error('ENDPOINT_BINDING_MISMATCH');
        }
        return parsed.endpoints;
      },
    })
  ).value;
  return result.map((endpoint) => ({
    id: endpoint.id,
    projectId: endpoint.project_id,
    branchId: endpoint.branch_id,
    regionId: endpoint.region_id,
    host: endpoint.host,
    type: endpoint.type,
  }));
}

/** Bind the direct TLS URL to one independently inventoried read-write endpoint. */
export function verifyNeonDirectEndpoint(
  connection: NeonDirectConnection,
  endpoints: readonly NeonEndpoint[],
  expectedRegionId: string
): NeonEndpoint {
  const region = ExternalIdentifierSchema.parse(expectedRegionId);
  const matches = endpoints.filter(
    (endpoint) =>
      endpoint.id === connection.endpoint.id &&
      endpoint.host === connection.endpoint.host &&
      endpoint.projectId === connection.endpoint.projectId &&
      endpoint.branchId === connection.endpoint.branchId &&
      endpoint.regionId === region &&
      endpoint.type === 'read_write'
  );
  if (matches.length !== 1) throw new Error('ENDPOINT_BINDING_MISMATCH');
  return matches[0]!;
}

/** Read and validate one direct TLS URL while returning only a redacting wrapper. */
export async function readNeonDirectConnection(
  options: NeonReadOptions,
  projectId: string,
  branchId: string,
  databaseName: string,
  roleName: string
): Promise<NeonDirectConnection> {
  const project = ExternalIdentifierSchema.parse(projectId);
  const branch = ExternalIdentifierSchema.parse(branchId);
  const database = ExternalLabelSchema.parse(databaseName);
  const role = ExternalLabelSchema.parse(roleName);
  return (
    await runProviderCommand({
      ...options,
      args: [
        'connection-string',
        branch,
        '--project-id',
        project,
        '--database-name',
        database,
        '--role-name',
        role,
        '--no-pooled',
        '--ssl',
        'require',
      ],
      parse: (stdout) => {
        const raw = stdout.trim();
        const url = new URL(raw);
        if (url.protocol !== 'postgresql:' || !url.password || url.username !== role) {
          throw new Error('INVALID_CONNECTION_URL');
        }
        if (decodeURIComponent(url.pathname.slice(1)) !== database) {
          throw new Error('DATABASE_BINDING_MISMATCH');
        }
        if (
          url.searchParams.get('sslmode') !== 'require' ||
          url.searchParams.get('channel_binding') !== 'require' ||
          url.hostname.includes('-pooler.')
        ) {
          throw new Error('DIRECT_TLS_REQUIRED');
        }
        const endpointId = url.hostname.match(/^(ep-[a-z0-9-]+)\./u)?.[1];
        if (!endpointId) throw new Error('ENDPOINT_ID_MISSING');
        return {
          endpoint: {
            id: ExternalIdentifierSchema.parse(endpointId),
            host: ExternalIdentifierSchema.parse(url.hostname),
            projectId: project,
            branchId: branch,
            databaseName: database,
            roleName: role,
          },
          credential: new NeonConnectionCredential(raw),
        };
      },
    })
  ).value;
}
