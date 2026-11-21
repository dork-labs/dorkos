import { z } from 'zod';

const coordinate = z.number().finite().min(0).max(100_000);
const delta = z.number().finite().min(-100_000).max(100_000);
const button = z.enum(['left', 'middle', 'right', 'none']);
const modifiers = z.number().int().min(0).max(15);
/** App-only finite inputs. No protocol command, target or expression is accepted. */
export const browserViewerInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('pointer'),
      type: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased']),
      x: coordinate,
      y: coordinate,
      button,
      clickCount: z.number().int().min(0).max(3),
      modifiers: modifiers.default(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wheel'),
      x: coordinate,
      y: coordinate,
      deltaX: delta,
      deltaY: delta,
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['keyDown', 'keyUp']),
      key: z.string().min(1).max(64),
      code: z.string().max(64),
      modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal('touch'),
      type: z.enum(['touchStart', 'touchMove', 'touchEnd', 'touchCancel']),
      points: z
        .array(
          z.object({ x: coordinate, y: coordinate, id: z.number().int().min(0).max(31) }).strict()
        )
        .max(10),
    })
    .strict(),
  z.object({ kind: z.literal('text'), text: z.string().max(2_048) }).strict(),
  z
    .object({
      kind: z.literal('composition'),
      text: z.string().max(2_048),
      selectionStart: z.number().int().min(0).max(2_048),
      selectionEnd: z.number().int().min(0).max(2_048),
    })
    .strict(),
]);
export type BrowserViewerInput = z.input<typeof browserViewerInputSchema>;
export interface BrowserViewerChooser {
  id: string;
  host: string;
  multiple: boolean;
  navigationGeneration: number;
}
