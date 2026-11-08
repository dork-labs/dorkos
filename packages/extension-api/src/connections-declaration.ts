/**
 * `serverCapabilities.connections` in `extension.json`: the services an
 * extension's server half reads through DorkOS, and the exact read operations
 * it wants on each (DOR-3547). A person approves them per service; the
 * approval covers exactly the operations they saw, so adding one asks again.
 *
 * Also the heap limit schema for an extension that runs separately, moved
 * here from `manifest-schema.ts` to keep that file under its size limit.
 *
 * @module extension-api/connections-declaration
 */
import { z } from 'zod';

/** The most services one manifest may declare. */
export const CONNECTIONS_MAX_SERVICES = 8;

/** The most operations one service declaration may list. */
export const CONNECTION_OPERATIONS_MAX = 32;

/** The longest `why` line, shown on the person's card. */
export const CONNECTION_WHY_MAX = 120;

/** Refusal when `connections` is declared by an extension that runs inside DorkOS. */
export const CONNECTIONS_NEED_SUBPROCESS =
  'connections needs runtime "subprocess": an extension that runs inside DorkOS can\'t hold a connection';

/** An operation slug as the connections catalog names it. */
const OperationSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'an operation is a slug like LINEAR_LIST_LINEAR_PROJECTS');

/** One service an extension reads, and the operations it wants there. */
const ConnectionDeclarationSchema = z
  .object({
    /** The service (toolkit) id, as the connections catalog names it, e.g. `linear`. */
    service: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'a service is a lowercase id like linear'),
    /** Only `read` in this version: an extension can't change anything in an app. */
    access: z.literal('read'),
    /** The exact read operations, each once. */
    operations: z.array(OperationSlugSchema).min(1).max(CONNECTION_OPERATIONS_MAX),
    /** One line for the person's card: what the extension does with it. */
    why: z.string().min(1).max(CONNECTION_WHY_MAX).optional(),
  })
  .strict();

/** One service an extension reads. */
export type ConnectionDeclaration = z.infer<typeof ConnectionDeclarationSchema>;

/** `serverCapabilities.connections`: each service once, each operation once. */
export const ConnectionDeclarationsSchema = z
  .array(ConnectionDeclarationSchema)
  .min(1)
  .max(CONNECTIONS_MAX_SERVICES)
  .superRefine((declarations, ctx) => {
    const services = new Set<string>();
    declarations.forEach((declaration, index) => {
      if (services.has(declaration.service)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'service'],
          message: `"${declaration.service}" is declared more than once`,
        });
      }
      services.add(declaration.service);
      const operations = new Set<string>();
      declaration.operations.forEach((operation, at) => {
        if (operations.has(operation)) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'operations', at],
            message: `"${operation}" is listed more than once`,
          });
        }
        operations.add(operation);
      });
    });
  });

/**
 * Refuse `connections` on an extension that doesn't run in the subprocess
 * runtime (DOR-3547 §2): an in-process server half shares DorkOS's memory, so
 * "this extension" would mean nothing there.
 *
 * @param caps - The parsed `serverCapabilities`.
 * @param ctx - The refinement context.
 */
export function checkConnectionsDeclaration(
  caps: { runtime?: 'in-process' | 'subprocess'; connections?: ConnectionDeclaration[] },
  ctx: z.RefinementCtx
): void {
  if (caps.connections && caps.runtime !== 'subprocess') {
    ctx.addIssue({ code: 'custom', path: ['connections'], message: CONNECTIONS_NEED_SUBPROCESS });
  }
}

/** The smallest, largest and default heap for an extension that runs separately, in MB. */
export const ISOLATION_MEMORY_MB = { min: 64, max: 1024, default: 256 } as const;

/** Limits for an extension that runs separately. */
export const ExtensionLimitsSchema = z
  .object({
    /** Its JavaScript heap, in MB (64 to 1024, default 256). */
    memoryMb: z
      .number()
      .int()
      .min(ISOLATION_MEMORY_MB.min)
      .max(ISOLATION_MEMORY_MB.max)
      .default(ISOLATION_MEMORY_MB.default),
  })
  .strict();
