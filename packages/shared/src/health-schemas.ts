/**
 * The shared verdict shape behind `dorkos doctor` and `GET /api/health/deep`.
 *
 * One check produces one {@link CheckResult}: a short label, a status, and
 * optional context. The CLI renders them; the server returns them. Both sides
 * import this module so the two never drift into two nearly-identical types.
 *
 * A check reports *that* something is wrong and how much of it there is. It
 * never carries message text, prompts, file contents, tokens, or absolute
 * paths into private directories — a deep-health response is readable by
 * anything that can reach the server's health endpoint.
 *
 * @module health-schemas
 */
import { z } from 'zod';

/** Outcome of a single check. `fail` is the only status that affects an exit code. */
export const CheckStatusSchema = z.enum(['pass', 'warn', 'fail', 'info']);

/** Outcome of a single check. `fail` is the only status that affects an exit code. */
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

/** A renderable verdict from one check. */
export const CheckResultSchema = z.object({
  /** Short, plain label shown on the checklist line. */
  label: z.string(),
  /** Verdict. Only `fail` makes `dorkos doctor` exit non-zero. */
  status: CheckStatusSchema,
  /** Optional one-line context shown dimmed under the label. */
  detail: z.string().optional(),
  /** Optional next step, shown for `warn`/`fail`. */
  fix: z.string().optional(),
});

/** A renderable verdict from one check. */
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * The body of `GET /api/health/deep`.
 *
 * Always returned with HTTP 200: a failing check is data about the machine, not
 * a failure of the request.
 */
export const DeepHealthResponseSchema = z.object({
  checks: z.array(CheckResultSchema),
});

/** The body of `GET /api/health/deep`. */
export type DeepHealthResponse = z.infer<typeof DeepHealthResponseSchema>;
