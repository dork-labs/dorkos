/** Local browser control shared by the app, desktop, and scoped agent tools. */
import { z } from 'zod';

export const LocalBrowserModeSchema = z.enum(['embedded', 'new-window']);
export type LocalBrowserMode = z.infer<typeof LocalBrowserModeSchema>;
export const LocalBrowserOpenSchema = z
  .object({
    mode: LocalBrowserModeSchema,
    sessionId: z.string().min(1).max(200).optional(),
    url: z.string().url().optional(),
    /** A named profile to open in a new window. Left out, the default sign-ins are used. */
    profileId: z.string().uuid().optional(),
  })
  .strict();
export type LocalBrowserOpen = z.infer<typeof LocalBrowserOpenSchema>;
/** A named set of browser sign-ins, and the agents a person let use it. */
export const LocalBrowserProfileSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  createdAt: z.string(),
  agentIds: z.array(z.string()),
});
export type LocalBrowserProfile = z.infer<typeof LocalBrowserProfileSchema>;
/** Name a new profile. It starts with no agents. */
export const LocalBrowserProfileCreateSchema = z
  .object({ label: z.string().trim().min(1).max(80) })
  .strict();
/** Let one agent use a profile. */
export const LocalBrowserProfileBindSchema = z.object({ agentId: z.string().min(1) }).strict();
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
/** What a person's controls see: the browser plus its handoff and sign-in. Never sent to an agent. */
export interface LocalBrowserPersonState extends LocalBrowserState {
  handoff: LocalBrowserHandoff | null;
  signIn: LocalBrowserSignIn | null;
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
/** A plain sign-in window and whether its sign-in reached the disk. */
export const LocalBrowserSignInSchema = z.object({
  profileId: z.string().nullable(),
  /** The host of the page the window opened, from its URL. */
  site: z.string(),
  status: z.enum(['open', 'saving', 'saved', 'failed']),
  startedAt: z.string(),
});
export type LocalBrowserSignIn = z.infer<typeof LocalBrowserSignInSchema>;

/** Why an agent handed the browser to the person. */
export const LocalBrowserHandoffReasonSchema = z.enum(['wall', 'password']);
export type LocalBrowserHandoffReason = z.infer<typeof LocalBrowserHandoffReasonSchema>;

/**
 * An agent handed the browser to the person. While `outcome` is null the agent
 * can't read or use the browser. The record stays after it ends, so every place
 * that shows it can say how it ended.
 */
export const LocalBrowserHandoffSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  reason: LocalBrowserHandoffReasonSchema,
  /** The host of the agent's page when it asked, from its URL. Never a name the agent gave. */
  site: z.string(),
  askedAt: z.string(),
  outcome: z.enum(['handed-back', 'stopped']).nullable(),
});
export type LocalBrowserHandoff = z.infer<typeof LocalBrowserHandoffSchema>;

/** Start a sign-in: a page the person typed, or the agent's current page during a handoff. */
export const LocalBrowserSignInRequestSchema = z.union([
  z
    .object({
      url: z.string().url(),
      /** A named profile. Left out, the default sign-ins are used. */
      profileId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ handoffId: z.string().min(1) }).strict(),
]);
export type LocalBrowserSignInRequest = z.infer<typeof LocalBrowserSignInRequestSchema>;

/** Which handoff a person's Hand back or Stop task answers. */
export const LocalBrowserHandoffAnswerSchema = z.object({ handoffId: z.string().min(1) }).strict();

/** What an agent sends to hand the browser to the person. */
export const LocalBrowserAskPersonSchema = z
  .object({
    reason: LocalBrowserHandoffReasonSchema.describe(
      '"password" when the page asks for a password or sign-in; "wall" for any other step only a person can finish.'
    ),
  })
  .strict();

/** The person's view of the browser; see {@link LocalBrowserPersonState}. */
export const LocalBrowserPersonStateSchema = LocalBrowserStateSchema.extend({
  handoff: LocalBrowserHandoffSchema.nullable(),
  signIn: LocalBrowserSignInSchema.nullable(),
});

/** What the agent hears back. */
export const LocalBrowserAskPersonResultSchema = z.object({
  handoffId: z.string(),
  site: z.string(),
  next: z.string(),
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
