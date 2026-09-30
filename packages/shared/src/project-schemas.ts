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

/**
 * One Claude account as a project's account rule sees it
 * (`GET /api/runtimes/claude-code/account-eligibility`, spec
 * `flow-multiproject` §8.6). An account works in a project only when both its
 * own rule (`allowedByAccount`) and the project's (`allowedByProject`) allow it.
 */
export const AccountEligibilityRowSchema = z
  .object({
    /** The registry id, or `default` for Main (this computer's own sign-in). */
    id: z.string(),
    /** What the person calls the account, or null when unnamed. */
    label: z.string().nullable(),
    /** The color its dot is drawn in, lowercase `#rrggbb`. */
    color: z.string(),
    /** True for Main when it has no registry row. */
    implicit: z.boolean(),
    /** The projects the account is kept to, or null for any project. */
    onlyProjects: z.array(ProjectRefSchema).nullable(),
    /** Whether the account's own rule lets it work here. */
    allowedByAccount: z.boolean(),
    /** Whether the project's rule lets it work here (true with no project rule). */
    allowedByProject: z.boolean(),
    /** Whether it may work here: both rules allow it. */
    eligible: z.boolean(),
  })
  .openapi('AccountEligibilityRow');

/** One account as a project's rule sees it. See {@link AccountEligibilityRowSchema}. */
export type AccountEligibilityRow = z.infer<typeof AccountEligibilityRowSchema>;

/** Query of `GET /api/runtimes/claude-code/account-eligibility`. */
export const AccountEligibilityQuerySchema = z
  .object({
    /**
     * Any folder; the answer is for the project it belongs to. Leave it out for
     * a folder in no project.
     */
    project: z.string().min(1).optional(),
  })
  .openapi('AccountEligibilityQuery');

/** Response body of `GET /api/runtimes/claude-code/account-eligibility`. */
export const AccountEligibilityResponseSchema = z
  .object({
    /** The project the folder belongs to, or null when it is in no project. */
    project: ProjectRefSchema.nullable(),
    /** The project's own allow list, or null when it has none (every account). */
    allow: z.array(z.string()).nullable(),
    /** Every Claude account, in registry order, Main last when it has no row. */
    accounts: z.array(AccountEligibilityRowSchema),
    /**
     * What a new chat in this folder would run on when nobody picks an account:
     * the launch ladder's own answer (the folder's agent's account, else the
     * default, skipping to the next account that may work here), or why it
     * would be refused. A picker's "Default" row names this, never a guess.
     * Absent on a server too old to say.
     */
    launch: z
      .discriminatedUnion('ok', [
        z.object({
          ok: z.literal(true),
          /** The account's registry id, or `default` for Main. */
          accountId: z.string(),
          /** The Claude folder it runs in. */
          root: z.string(),
        }),
        z.object({
          ok: z.literal(false),
          /** The plain sentence the launch would be refused with. */
          message: z.string(),
        }),
      ])
      .optional(),
  })
  .openapi('AccountEligibilityResponse');

/** Response body of `GET /api/runtimes/claude-code/account-eligibility`. */
export type AccountEligibilityResponse = z.infer<typeof AccountEligibilityResponseSchema>;

/** Body of `PUT /api/runtimes/claude-code/project-accounts`. */
export const ProjectAccountsRequestSchema = z
  .object({
    /** Any folder in the project. */
    project: z.string().min(1),
    /** The account ids that may work there, or null to remove the project's rule. */
    allow: z.array(z.string().min(1)).nullable(),
  })
  .openapi('ProjectAccountsRequest');

/** Body of `PUT /api/runtimes/claude-code/project-accounts`. */
export type ProjectAccountsRequest = z.infer<typeof ProjectAccountsRequestSchema>;

/** Body of `PUT /api/runtimes/claude-code/accounts/:id/only-projects`. */
export const OnlyProjectsRequestSchema = z
  .object({
    /** Folders of the projects the account may work in, or null for any project. */
    projects: z.array(z.string().min(1)).nullable(),
  })
  .openapi('OnlyProjectsRequest');

/** Body of `PUT /api/runtimes/claude-code/accounts/:id/only-projects`. */
export type OnlyProjectsRequest = z.infer<typeof OnlyProjectsRequestSchema>;

/** Response body of `PUT /api/runtimes/claude-code/accounts/:id/only-projects`. */
export const OnlyProjectsResponseSchema = z
  .object({
    /** The projects the account is now kept to, or null for any project. */
    onlyProjects: z.array(ProjectRefSchema).nullable(),
  })
  .openapi('OnlyProjectsResponse');

/** Response body of `PUT /api/runtimes/claude-code/accounts/:id/only-projects`. */
export type OnlyProjectsResponse = z.infer<typeof OnlyProjectsResponseSchema>;

/**
 * The machine-readable code of every account-eligibility refusal. A launch
 * refused this way answers HTTP `409` with `{ error, message, code, project,
 * accountId }` (spec `flow-multiproject` §8.3).
 */
export const ACCOUNT_NOT_ALLOWED_CODE = 'account_not_allowed_here';
