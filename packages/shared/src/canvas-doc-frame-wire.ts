/** Doc frame correlation is host-owned lifetime data, never page authority or a client hash. */
import { z } from 'zod';
import {
  PageEventSchema,
  CanvasChannelEventReceiptSchema,
  CanvasChannelEventSchema,
  CanvasChannelSequenceSchema,
  CanvasChannelStateSchema,
  inspectCanvasChannelJson,
} from './canvas-channel-schemas.js';

import { CanvasDocIncarnationSchema } from './canvas-doc-incarnation.js';
export {
  CanvasDocIncarnationSchema,
  sameCanvasDocIncarnation,
  type CanvasDocIncarnation,
} from './canvas-doc-incarnation.js';

const token = z.string().min(1).max(128);
const correlation = {
  protocol: z.literal('dorkos-doc'),
  v: z.literal(1),
  nonce: token,
  requestToken: token,
  loadToken: CanvasChannelSequenceSchema,
  generation: CanvasDocIncarnationSchema.shape.generation,
};
/**
 * The fragment parameter a host puts on a served document's frame `src`.
 *
 * Its value is a one-navigation boot nonce. The injected shim reads and removes
 * it before any page script runs, then answers each challenge with it, so only
 * the document DorkOS itself navigated the frame to can prove it is that
 * document — a page reached by a link, a form, a redirect or `location` cannot.
 */
export const CANVAS_DOC_BOOT_PARAM = 'dorkos-boot';
/** Strict window handshake; ports belong only to the connect transfer, never its payload. */
export const CanvasDocHandshakeSchema = z.discriminatedUnion('kind', [
  z.object({ ...correlation, kind: z.literal('challenge') }).strict(),
  // `boot` is the served document's boot nonce; a preview, pinned by its own
  // origin, has none.
  z.object({ ...correlation, kind: z.literal('ack'), boot: token.optional() }).strict(),
  z.object({ ...correlation, kind: z.literal('connect') }).strict(),
]);
/**
 * One document event as the page sees it: its sequence and the event, never the
 * session or room it streamed through, nor the document's incarnation.
 */
export const CanvasDocPageFrameSchema = z
  .object({
    type: z.literal('canvas_event'),
    docSeq: CanvasChannelSequenceSchema,
    event: CanvasChannelEventSchema,
  })
  .strict();
/** A page-facing event frame. */
export type CanvasDocPageFrame = z.infer<typeof CanvasDocPageFrameSchema>;
/** Correlated handshake without routing, permission, credential or document-path fields. */
export type CanvasDocHandshake = z.infer<typeof CanvasDocHandshakeSchema>;
/** Public page command on its dedicated Doc port. */
export const CanvasDocCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...correlation, kind: z.literal('emit'), requestId: token, event: PageEventSchema })
    .strict(),
  z.object({ ...correlation, kind: z.literal('retire') }).strict(),
]);
/** Public upstream command, retaining the original envelope ID. */
export type CanvasDocCommand = z.infer<typeof CanvasDocCommandSchema>;
/** Host results distinguish durable acceptance from uncertain or canceled local work. */
export const CanvasDocResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...correlation,
      kind: z.literal('receipt'),
      requestId: token,
      receipt: CanvasChannelEventReceiptSchema,
    })
    .strict(),
  z
    .object({
      ...correlation,
      kind: z.literal('refused'),
      requestId: token,
      outcome: z.enum(['cancelled', 'unconfirmed', 'refused']),
    })
    .strict(),
  z
    .object({
      ...correlation,
      kind: z.literal('state'),
      state: CanvasChannelStateSchema,
      stateRev: CanvasChannelSequenceSchema,
      docSeq: CanvasChannelSequenceSchema,
      reset: z.boolean(),
    })
    .strict(),
  z.object({ ...correlation, kind: z.literal('event'), frame: CanvasDocPageFrameSchema }).strict(),
  z
    .object({
      ...correlation,
      kind: z.literal('status'),
      status: z.enum(['connecting', 'ready', 'offline', 'revoked']),
      unconfirmed: z.boolean(),
    })
    .strict(),
]);
/** Durable projection or explicit local uncertainty, not proof an agent handled an event. */
export type CanvasDocResult = z.infer<typeof CanvasDocResultSchema>;
/** Bound clone data before Zod traversal; accessors/exotic JSON are conservatively refused. */
export function parseCanvasDocWire<T>(schema: z.ZodType<T>, value: unknown): T | null {
  try {
    if (inspectCanvasChannelJson(value, 1_048_576) !== undefined) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
