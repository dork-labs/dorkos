/** Neutral server-projected Doc birth. Clients compare it; they never mint authority. */
import { z } from 'zod';

/** Exact retained physical/channel birth, projected by the authorized server. */
export const CanvasDocIncarnationSchema = z
  .object({
    v: z.literal(1),
    documentId: z.string().min(1).max(200),
    physicalOpenedAt: z.string().max(64).datetime({ offset: true }),
    channelCreatedAt: z.string().max(64).datetime({ offset: true }),
    generation: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .meta({ pattern: '^[a-f0-9]{64}$' }),
  })
  .strict();
/** Server-projected birth; clients compare it and never calculate a replacement. */
export type CanvasDocIncarnation = z.infer<typeof CanvasDocIncarnationSchema>;
/** Compare every immutable birth field, including timestamps rather than generation alone. */
export function sameCanvasDocIncarnation(
  a: CanvasDocIncarnation,
  b: CanvasDocIncarnation
): boolean {
  return (
    a.v === b.v &&
    a.documentId === b.documentId &&
    a.physicalOpenedAt === b.physicalOpenedAt &&
    a.channelCreatedAt === b.channelCreatedAt &&
    a.generation === b.generation
  );
}
