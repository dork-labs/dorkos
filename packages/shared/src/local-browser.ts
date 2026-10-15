/** Local browser control shared by the app, desktop, and scoped agent tools. */
import { z } from 'zod';

export const LocalBrowserModeSchema = z.enum(['embedded', 'new-window']);
export type LocalBrowserMode = z.infer<typeof LocalBrowserModeSchema>;
export const LocalBrowserOpenSchema = z
  .object({
    mode: LocalBrowserModeSchema,
    sessionId: z.string().min(1).max(200).optional(),
    url: z.string().url().optional(),
  })
  .strict();
export type LocalBrowserOpen = z.infer<typeof LocalBrowserOpenSchema>;
export const LocalBrowserKeySchema = z.enum([
  'Enter',
  'Tab',
  'Shift+Tab',
  'Escape',
  'ArrowDown',
  'ArrowUp',
  'ArrowLeft',
  'ArrowRight',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
export const LocalBrowserActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('navigate'),
      revision: z.number().int().nonnegative(),
      url: z.string().url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('click'),
      revision: z.number().int().nonnegative(),
      role: z.string().min(1),
      name: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('fill'),
      revision: z.number().int().nonnegative(),
      role: z.string().min(1),
      name: z.string().min(1),
      text: z.string().max(100_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('press'),
      revision: z.number().int().nonnegative(),
      key: LocalBrowserKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      revision: z.number().int().nonnegative(),
      deltaX: z.number().finite().min(-4000).max(4000),
      deltaY: z.number().finite().min(-4000).max(4000),
    })
    .strict(),
]);
export type LocalBrowserAction = z.infer<typeof LocalBrowserActionSchema>;
export interface LocalBrowserTab {
  id: string;
  url: string;
  title: string;
}
/** Genuine managed-browser acquisition state; percent belongs only to its current component. */
export const LocalBrowserPreparationSchema = z.object({
  stage: z.enum(['checking', 'downloading', 'launching']),
  component: z.enum(['chromium', 'headless-shell', 'ffmpeg']).nullable(),
  percent: z.number().min(0).max(100).nullable(),
});
export type LocalBrowserPreparation = z.infer<typeof LocalBrowserPreparationSchema>;

export interface LocalBrowserState {
  connectionId: string | null;
  sessionId: string | null;
  mode: LocalBrowserMode | null;
  status: 'disconnected' | 'connected' | 'closed';
  paused: boolean;
  tabs: LocalBrowserTab[];
  selectedTabId: string | null;
  revision: number;
  preparation: LocalBrowserPreparation | null;
}
export interface LocalBrowserObservation {
  revision: number;
  snapshot: string;
  url: string;
  tabId: string;
}
export interface LocalBrowserCapabilities {
  platform: string;
  managedChromiumVersion: string;
  unavailableReasons: Partial<Record<LocalBrowserMode, string>>;
  embedded: boolean;
  newWindow: boolean;
  playwrightVersion: string;
  defaultMode: LocalBrowserMode;
}

export const LocalBrowserStateSchema = z.object({
  preparation: LocalBrowserPreparationSchema.nullable(),
  connectionId: z.string().nullable(),
  sessionId: z.string().nullable(),
  mode: LocalBrowserModeSchema.nullable(),
  status: z.enum(['disconnected', 'connected', 'closed']),
  paused: z.boolean(),
  tabs: z.array(z.object({ id: z.string(), url: z.string(), title: z.string() })),
  selectedTabId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
export const LocalBrowserObservationSchema = z.object({
  revision: z.number().int().nonnegative(),
  snapshot: z.string(),
  url: z.string(),
  tabId: z.string(),
});

export const LocalBrowserCapabilitiesSchema = z.object({
  platform: z.string().min(1),
  managedChromiumVersion: z.string(),
  unavailableReasons: z.object({
    embedded: z.string().optional(),
    'new-window': z.string().optional(),
  }),
  embedded: z.boolean(),
  newWindow: z.boolean(),
  playwrightVersion: z.string(),
  defaultMode: LocalBrowserModeSchema,
});
