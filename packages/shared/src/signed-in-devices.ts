/**
 * A person's own signed-in devices (F4 part 2, DOR-2969): the sign-ins their
 * account has open, how each came in, and signing one out (`/api/devices`).
 *
 * A sign-in is named by an opaque id the server derives from it, never by its
 * token: the list can be shown, logged and sent back without handing anyone a
 * credential.
 *
 * Pure: schemas, types and the Transport slice only.
 *
 * @module shared/signed-in-devices
 */
import { z } from 'zod';

/**
 * How a sign-in came in, and the only way it works: this computer, Wi-Fi,
 * your own tunnel, managed remote access, another network path, or a hub
 * (DorkOS in the cloud).
 */
export const SignedInDeviceRouteSchema = z.enum([
  'local',
  'wifi',
  'tunnel',
  'managed',
  'network',
  'hub',
]);

/** See {@link SignedInDeviceRouteSchema}. */
export type SignedInDeviceRoute = z.infer<typeof SignedInDeviceRouteSchema>;

/** One sign-in on the person's account. Never carries its token. */
export const SignedInDeviceSchema = z.object({
  /** An opaque id for this sign-in, stable while the server runs. Not a credential. */
  id: z.string(),
  /** How the sign-in came in. */
  route: SignedInDeviceRouteSchema,
  /** When it was made (ISO 8601). */
  createdAt: z.string(),
  /** When it was last renewed by use (ISO 8601). */
  lastSeenAt: z.string(),
  /** Whether it is the sign-in asking. */
  current: z.boolean(),
  /** The browser and system it came from, in a few words, when known. */
  userAgentLabel: z.string().optional(),
});

/** See {@link SignedInDeviceSchema}. */
export type SignedInDevice = z.infer<typeof SignedInDeviceSchema>;

/** `GET /api/devices/sessions`. */
export const SignedInDeviceListSchema = z.object({
  /** The account's live sign-ins, the asking one first, then most recent. */
  sessions: z.array(SignedInDeviceSchema),
  /**
   * Whether the caller may sign out other devices: only a person at the
   * computer DorkOS runs on.
   */
  canSignOutOthers: z.boolean(),
});

/** See {@link SignedInDeviceListSchema}. */
export type SignedInDeviceList = z.infer<typeof SignedInDeviceListSchema>;

/** `POST /api/devices/sign-out-all`: how many other sign-ins ended. */
export const SignOutEverywhereElseResultSchema = z.object({
  /** Sign-ins ended. The asking one is kept. */
  signedOut: z.number().int().nonnegative(),
});

/** See {@link SignOutEverywhereElseResultSchema}. */
export type SignOutEverywhereElseResult = z.infer<typeof SignOutEverywhereElseResultSchema>;

/** What the app asks the server about the person's own sign-ins. */
export interface SignedInDevicesTransport {
  /** The person's own sign-ins. Never tokens. */
  listSignedInDevices(): Promise<SignedInDeviceList>;
  /**
   * Sign one device out, closing whatever it had open. Your own from
   * anywhere; another only at the computer DorkOS runs on.
   *
   * @param id - The sign-in's opaque id from the list.
   */
  signOutDevice(id: string): Promise<void>;
  /** Sign out every device but this one. At the computer DorkOS runs on only. */
  signOutEverywhereElse(): Promise<SignOutEverywhereElseResult>;
}
