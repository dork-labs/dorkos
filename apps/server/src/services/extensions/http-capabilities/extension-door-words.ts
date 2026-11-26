/**
 * The fixed words of the extension doors (DOR-4978): the id every door checks,
 * what each door's person bar says when it refuses, and every refusal the
 * doors the capability mount serves answer with. The hand routes that stay
 * (`routes/extensions*.ts`) read the same copies, so a door says the same
 * thing whichever way it is served.
 *
 * Imports nothing but types, so the mount's refusal table can load it.
 *
 * @module services/extensions/http-capabilities/extension-door-words
 */
import type { PersonBarCopy } from '@dorkos/shared/capabilities';
import type { ProblemCode } from '@dorkos/shared/problem';

/** An extension id, as the manifest schema spells it (kebab-case alphanumeric). */
export const SAFE_EXT_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Allowing an extension to run, taking that back, and "Not now": a security
 * decision, so `person_only`, naming who may make it.
 */
export const APPROVAL_BAR = {
  code: 'person_only',
  subject: 'which extensions may run',
  agent: 'Nothing changed. Only a person allows an extension to run, in Settings.',
} as const satisfies PersonBarCopy;

/** Removing an extension, and forgetting the approval of one that is gone. */
export const REMOVAL_BAR = {
  code: 'person_only',
  subject: 'which extensions are installed',
  agent: 'Nothing changed. Only a person removes an extension, in Settings.',
} as const satisfies PersonBarCopy;

/** Restarting an extension that stopped too often (DOR-4785). */
export const RESTART_BAR = {
  code: 'person_only',
  subject: 'app restarts',
  agent: 'DorkOS restarted nothing. Ask a person to restart it in the app.',
} as const satisfies PersonBarCopy;

/**
 * Turning an extension on or off (DOR-1507). They write `extensions.enabled` /
 * `extensions.disabled`, both `operator-only`, and answer `person_only`: a
 * refusal of an agent is not about where the caller is.
 */
export const EXTENSION_TOGGLE_BAR = {
  code: 'person_only',
  subject: 'which extensions are turned on',
  agent: 'Nothing changed. Only a person turns extensions on or off, in Settings.',
} as const satisfies PersonBarCopy;

/** One refusal: its problem code, its sentence, and any other sentence it may say. */
export interface ExtensionDoorRefusal {
  /** The problem code. */
  readonly code: ProblemCode;
  /** The sentence sent for this refusal. */
  readonly detail: string;
  /** Other fixed sentences this refusal may say, each sent as it is. */
  readonly alsoSays?: readonly string[];
}

/**
 * Why a remove was refused, in words a person reads. Fixed sentences: the
 * removal door sends the one that applies.
 */
export const REMOVE_REFUSAL_COPY = {
  core: 'It comes with DorkOS, so it can’t be removed. Turn it off instead.',
  plugin: 'It came with a plugin. Uninstall the plugin in Marketplace to remove it.',
  dev_link: 'It runs from a folder you linked. Unlink it in Marketplace.',
  unexpected_folder: 'Its folder isn’t where DorkOS keeps extensions. Remove it by hand.',
} as const;

/** What a stale copy is told when nothing was turned off or dismissed. */
export const CHANGED_NOTHING = 'This extension changed since you saw it. Nothing changed.';

/** What a person is told when the copy on disk is not the one they approved. */
export const NEEDS_APPROVAL = 'It changed or waits for your approval. Review it in Settings.';

/**
 * Every refusal the extension doors on the mount answer with, by tool code.
 * The hand routes named the extension's id in a few of these; the mount sends
 * only fixed sentences, so those say "that extension" instead.
 */
export const EXTENSION_DOOR_TOOL_REFUSALS = {
  EXTENSION_NOT_INSTALLED: {
    code: 'not_found',
    detail: 'No extension with that id is installed.',
  },
  EXTENSION_APP_NOT_INSTALLED: { code: 'not_found', detail: 'No app with that id is installed.' },
  EXTENSION_NO_APPROVAL_LEFT: {
    code: 'not_found',
    detail: 'No approval is left for that extension.',
  },
  EXTENSION_SHIPS_WITH_DORKOS: {
    code: 'conflict',
    detail: 'It ships with DorkOS and never asks to run.',
  },
  EXTENSION_REMOVE_REFUSED: {
    code: 'conflict',
    detail: REMOVE_REFUSAL_COPY.unexpected_folder,
    alsoSays: Object.values(REMOVE_REFUSAL_COPY),
  },
  EXTENSION_STILL_INSTALLED: {
    code: 'conflict',
    detail: 'It’s still installed. Stop it running or remove it instead.',
  },
  EXTENSION_CHANGED_SINCE_SEEN: { code: 'precondition_failed', detail: CHANGED_NOTHING },
  EXTENSION_NEEDS_APPROVAL: { code: 'needs_approval', detail: NEEDS_APPROVAL },
  EXTENSION_RESTART_REFUSED: {
    code: 'conflict',
    detail: 'Couldn’t restart it. Check it’s turned on in Settings.',
    alsoSays: ['It no longer builds. Open Settings to see why.'],
  },
  EXTENSION_SERVER_NOT_STARTED: {
    code: 'upstream_unavailable',
    detail: 'Couldn’t start the app. Open Settings to check.',
  },
  EXTENSION_DOOR_FAILED: {
    code: 'internal_error',
    detail: 'Couldn’t change the extension. Try again.',
    alsoSays: [
      'Couldn’t save that. Try again.',
      'Couldn’t remove the extension. Try again.',
      'Couldn’t forget the approval. Try again.',
    ],
  },
} as const satisfies Readonly<Record<string, ExtensionDoorRefusal>>;
