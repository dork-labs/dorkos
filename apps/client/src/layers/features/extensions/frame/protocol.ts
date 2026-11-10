import { z } from 'zod';

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
  props: unknown;
  css: string;
  theme: FrameTheme;
}

/** The host root's classes and inline style: light or dark, plus the person's font choice. */
export interface FrameTheme {
  className: string;
  style: string;
}
