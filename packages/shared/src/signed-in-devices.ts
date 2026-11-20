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
  /**
   * What the device is called: its browser and platform ("Chrome on Mac"), or
   * "A web browser" when it said nothing known. A label, never a check.
   */
  name: z.string(),
  /**
   * Wi-Fi sign-ins only: whether the owner let this device run agents at their
   * own level. Off for every new sign-in, set only at the computer DorkOS runs
   * on, and gone when the device signs out or sits unused for 12 hours.
   */
  runsAgents: z.boolean().optional(),
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

/** One device on Wi-Fi waiting for the owner to approve its sign-in (DOR-4744). Never its secret. */
export const WifiSignInRequestSchema = z.object({
  /** The id the app approves or declines it by. */
  id: z.string(),
  /** What the device says it is ("Safari on iPhone"). A label, never a check. */
  deviceName: z.string(),
  /** Its address on this network. */
  address: z.string(),
  /** When it asked (ISO 8601). */
  requestedAt: z.string(),
  /** When it stops waiting (ISO 8601). */
  expiresAt: z.string(),
  /** The short code the device shows: approve only when the two match. */
  matchCode: z.string(),
  /** Whether a code was already shown for it. */
  approved: z.boolean(),
});

/** See {@link WifiSignInRequestSchema}. */
export type WifiSignInRequest = z.infer<typeof WifiSignInRequestSchema>;

/** `GET /api/devices/sign-in-requests`. */
export const WifiSignInRequestListSchema = z.object({
  requests: z.array(WifiSignInRequestSchema),
});

/** See {@link WifiSignInRequestListSchema}. */
export type WifiSignInRequestList = z.infer<typeof WifiSignInRequestListSchema>;

/** `POST /api/devices/sign-in-requests/:id/approve` once approved: the code to show. */
export const WifiSignInApprovalSchema = z.object({
  /** The one-time code to type on the device. */
  code: z.string(),
  /** When it stops working (ISO 8601). */
  expiresAt: z.string(),
});

/** See {@link WifiSignInApprovalSchema}. */
export type WifiSignInApproval = z.infer<typeof WifiSignInApprovalSchema>;

/** Answer code (428) when an action waits for a fresh passkey check; carries `options`. */
export const PASSKEY_CHECK_CODE = 'PASSKEY_CHECK_REQUIRED';

/** Answer code (409) when an action needs a passkey on this computer and there is none. */
export const PASSKEY_NEEDED_CODE = 'PASSKEY_NEEDED';

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
  /**
   * Let one Wi-Fi device run agents at their own level, or stop it. At the
   * computer DorkOS runs on only. Turning it on is called first with no
   * passkey, which asks for a fresh passkey check, then with its response.
   *
   * @param id - The sign-in's opaque id from the list.
   * @param on - On or off.
   * @param passkey - The browser's response to the passkey check, the second time.
   */
  setDeviceRunsAgents(id: string, on: boolean, passkey?: unknown): Promise<PasskeyCheckedStep>;
  /** Devices on Wi-Fi waiting to be approved. At the computer DorkOS runs on only. */
  listWifiSignInRequests(): Promise<WifiSignInRequestList>;
  /**
   * Approve one device's Wi-Fi sign-in. Called first with no passkey, which
   * asks for a fresh passkey check; then with the browser's passkey response,
   * which answers the one-time code to type on the device.
   *
   * @param id - The request's id from the list.
   * @param passkey - The browser's response to the passkey check, the second time.
   */
  approveWifiSignIn(id: string, passkey?: unknown): Promise<WifiSignInApprovalStep>;
  /**
   * Decline one device's Wi-Fi sign-in.
   *
   * @param id - The request's id from the list.
   */
  declineWifiSignIn(id: string): Promise<void>;
  /** The owner's sign-in checks. Read in person; changed at this computer only. */
  listOwnerFactors(): Promise<{ factors: OwnerFactor[] }>;
  /**
   * Start adding a passkey on this computer, after "Confirm it's you". With a
   * passkey here already, it asks for a fresh passkey check first, as below.
   *
   * @param label - What to call it.
   * @param passkey - The browser's response to the passkey check, the second time.
   * @returns The options to hand the browser, or the check to run.
   */
  startAddingPasskey(label: string, passkey?: unknown): Promise<PasskeyStartStep>;
  /**
   * Finish adding a passkey.
   *
   * @param response - The browser's new passkey.
   */
  finishAddingPasskey(response: unknown): Promise<{ id: string; host: string }>;
  /**
   * Start adding an authenticator app, after "Confirm it's you". With a
   * passkey on this computer, it is called first with no passkey, which asks
   * for a fresh passkey check, then with its response.
   *
   * @param label - What to call it.
   * @param passkey - The browser's response to the passkey check, the second time.
   */
  startAddingAuthenticator(label: string, passkey?: unknown): Promise<AuthenticatorStartStep>;
  /**
   * Confirm a new authenticator app with one of its codes.
   *
   * @param id - The pending authenticator's id.
   * @param code - A code it shows now.
   */
  confirmAuthenticator(id: string, code: string): Promise<{ id: string }>;
  /**
   * Remove one sign-in check, after "Confirm it's you". With a passkey on
   * this computer, it asks for a fresh passkey check first, as above.
   *
   * @param id - Its id.
   * @param passkey - The browser's response to the passkey check, the second time.
   */
  removeOwnerFactor(id: string, passkey?: unknown): Promise<PasskeyCheckedStep>;
}

/** One of the owner's sign-in checks: a passkey or an authenticator app (DOR-3647). */
export const OwnerFactorSchema = z.object({
  id: z.string(),
  kind: z.enum(['totp', 'passkey']),
  /** What the owner called it. */
  label: z.string(),
  /** A passkey's address, the only one it works on. */
  host: z.string().optional(),
  addedAt: z.string(),
  lastUsedAt: z.string().optional(),
});

/** See {@link OwnerFactorSchema}. */
export type OwnerFactor = z.infer<typeof OwnerFactorSchema>;

/** A new authenticator app waiting for its first code. */
export interface PendingAuthenticator {
  readonly id: string;
  /** The shared secret, to type in by hand. */
  readonly secret: string;
  /** The `otpauth://` address to scan. */
  readonly uri: string;
}

/** Where an action behind a fresh passkey check stands after one call. */
export type PasskeyCheckedStep =
  /** Done. */
  | { kind: 'done' }
  /** Run this passkey check, then call again with its response. */
  | { kind: 'passkey-check'; options: unknown }
  /** There is no passkey on this computer to check with yet. */
  | { kind: 'needs-passkey' };

/** Where starting a passkey stands after one call. */
export type PasskeyStartStep =
  | Exclude<PasskeyCheckedStep, { kind: 'done' }>
  /** Hand these options to the browser to make the new passkey. */
  | { kind: 'options'; options: unknown };

/** Where starting an authenticator app stands after one call. */
export type AuthenticatorStartStep =
  | Exclude<PasskeyCheckedStep, { kind: 'done' }>
  /** Started: show this secret and wait for its first code. */
  | { kind: 'started'; pending: PendingAuthenticator };

/** Where approving a Wi-Fi sign-in stands after one call. */
export type WifiSignInApprovalStep =
  | Exclude<PasskeyCheckedStep, { kind: 'done' }>
  /** Approved: show this code. */
  | { kind: 'approved'; code: string; expiresAt: string };
