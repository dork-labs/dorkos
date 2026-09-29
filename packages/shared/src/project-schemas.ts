/**
 * Projects — the wire contract for `GET /api/projects` and
 * `GET /api/projects/resolve` (spec `flow-multiproject` §6.1).
 *
 * A project is a git main checkout. Worktrees and subfolders belong to their
 * main checkout, and a folder in no repository belongs to no project. The
 * server resolves it (the client cannot run git) and remembers every project
 * it has seen, each with a short name that is safe in a URL and never changes
 * once given.
 *
 * @module shared/project-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/**
 * The characters a project name may hold. Everything else in a folder's name
 * becomes `-`; `~` is added only by the server, to tell two same-named
 * folders apart (`dorkos~work`).
 */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9._~-]+$/;

/** A project as the server knows it: a git main checkout and its short name. */
export const ProjectRefSchema = z
  .object({
    /** Absolute, canonical path of the main checkout. */
    root: z.string().min(1),
    /**
     * Short display name: URL-safe, unique among known projects, and stable
     * once assigned (the folder's name, or `name~parent` on a clash).
     */
    name: z.string().regex(PROJECT_NAME_PATTERN),
  })
  .openapi('ProjectRef');

/** A project as the server knows it. See {@link ProjectRefSchema}. */
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

/** A known project, with what the server learned about it. */
export const ProjectInfoSchema = ProjectRefSchema.extend({
  /** `owner/name` read from the `origin` remote (GitHub-style), or null. */
  originRepo: z.string().nullable(),
  /** ISO-8601 time the server last saw a session, agent, workspace or install here. */
  lastSeenAt: z.string(),
}).openapi('ProjectInfo');

/** A known project. See {@link ProjectInfoSchema}. */
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

/** Response body of `GET /api/projects`. */
export const ProjectListResponseSchema = z
  .object({
    /** Every known project whose folder exists, by name. */
    projects: z.array(ProjectInfoSchema),
  })
  .openapi('ProjectListResponse');

/** Response body of `GET /api/projects`. */
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

/** Query of `GET /api/projects/resolve`. */
export const ProjectResolveQuerySchema = z
  .object({
    /** Any folder; it must be inside the server's directory boundary. */
    cwd: z.string().min(1),
  })
  .openapi('ProjectResolveQuery');

/** Response body of `GET /api/projects/resolve`. */
export const ProjectResolveResponseSchema = z
  .object({
    /** The project the folder belongs to, or null when it is in no repository. */
    project: ProjectRefSchema.nullable(),
  })
  .openapi('ProjectResolveResponse');

/** Response body of `GET /api/projects/resolve`. */
export type ProjectResolveResponse = z.infer<typeof ProjectResolveResponseSchema>;
