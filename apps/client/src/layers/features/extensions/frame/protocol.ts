import { z } from 'zod';
import { WidgetDocumentSchema } from '@dorkos/shared/ui-widget';

/** Only host-owned placement slots cross the frame boundary. */
export const FrameRegistrationSchema = z
  .object({
    kind: z.enum(['component', 'page', 'settings', 'status', 'command', 'dialog']),
    key: z.string().min(1).max(200),
    id: z.string().max(120),
    slot: z
      .enum(['dashboard.sections', 'right-panel', 'sidebar.footer', 'settings.tabs'])
      .optional(),
    label: z.string().max(120).optional(),
    options: z
      .object({
        title: z.string().max(120).optional(),
        label: z.string().max(120).optional(),
        group: z.string().max(120).optional(),
        priority: z.number().finite().optional(),
        menu: z.boolean().optional(),
        icon: z.string().max(80).optional(),
        shortcut: z.string().max(80).optional(),
        showIn: z
          .object({
            agents: z.array(z.string()).optional(),
            rooms: z.array(z.string()).optional(),
            pages: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** A registration contains data only; executable views never enter the host. */
export type FrameRegistration = z.infer<typeof FrameRegistrationSchema>;

/** Every call carries the bound identity even though the private port already identifies it. */
export const FrameCallSchema = z
  .object({
    type: z.literal('call'),
    extensionId: z.string(),
    requestId: z.number().int().nonnegative(),
    method: z.string().max(80),
    args: z.array(z.unknown()).max(8),
  })
  .strict();

/** Data the host sends once, over a port it transfers only to the frame it created. */
export interface FrameInit {
  extensionId: string;
  code: string;
  state: unknown;
  slots: string[];
  view: string | null;
  /** How the view sizes itself in its slot: fill it, fit its height, or fit both ways. */
  fit: 'fill' | 'height' | 'both';
  props: unknown;
  css: string;
  theme: FrameTheme;
}

/** The host root's classes and inline style: light or dark, plus the person's font choice. */
export interface FrameTheme {
  className: string;
  style: string;
}

/** A web address that is plain `http:` or `https:`, nothing a browser runs or reads locally. */
const httpUrl = z
  .string()
  .max(4000)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Use an http or https address.');

/** A picture from a `data:image/…` URI or an https address. */
const imageSrc = z
  .string()
  .max(5_000_000)
  .refine(
    (value) => /^data:image\/[a-z0-9.+-]+[;,]/i.test(value) || value.startsWith('https://'),
    'Use a data:image address or an https address.'
  );

const title = z.string().max(120).optional();

/**
 * What an app may put on the canvas (Security, 2026-11-10): text, data, a
 * widget, a picture, or a web page. Files, PDFs, diffs, local paths and MCP
 * apps are refused, and nothing on the canvas talks back to the frame.
 */
export const FrameCanvasContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), content: z.string().max(200_000), title }).strict(),
  z.object({ type: z.literal('json'), data: z.json(), title }).strict(),
  z.object({ type: z.literal('widget'), definition: WidgetDocumentSchema, title }).strict(),
  z
    .object({ type: z.literal('image'), src: imageSrc, alt: z.string().max(400).optional(), title })
    .strict(),
  z.object({ type: z.literal('browser'), url: httpUrl, title }).strict(),
]);

/** A canvas document an app opened, after {@link FrameCanvasContentSchema} checked it. */
export type FrameCanvasContent = z.infer<typeof FrameCanvasContentSchema>;

/** A file an app asks DorkOS to offer for saving: a name and its text. */
export const FrameDownloadSchema = z
  .object({ name: z.string().min(1).max(400), content: z.string().max(10 * 1024 * 1024) })
  .strict();

// Zod overloads empty and nonempty tuples separately; this preserves the inferred tuple for both.
/** A fixed-length argument list, each checked by its own schema. */
export const args = <const T extends [] | [z.ZodType, ...z.ZodType[]]>(
  ...schemas: T
): z.ZodTuple<T> => z.tuple(schemas as []) as unknown as z.ZodTuple<T>;
/** One bounded string argument. */
export const text = z.string().max(4000);
/** Any JSON value. */
export const json = z.json();
