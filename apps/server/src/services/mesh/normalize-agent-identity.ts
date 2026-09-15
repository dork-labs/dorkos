/**
 * The one place a caller-supplied agent identity is checked and normalised
 * before it reaches a manifest.
 *
 * Three surfaces let one caller name another agent: the `mesh_register` MCP
 * tool (both servers), `POST /api/mesh/agents`, and `POST /api/agents`. All
 * three used to write whatever they were handed, and all three got it wrong in
 * the same way (DOR-2054):
 *
 * - **`name` is a slug, not a label.** It is immutable, and it is what an
 *   agent's `@handle` in a room is derived from
 *   (`services/rooms/author-registry.ts`: `deriveHandle(name) ?? deriveHandle(displayName)`).
 *   DorkBot sent `"DorkOS Cloud"` and the manifest stored that string, spaces
 *   and all. A display-style name is slugified here and kept as the display
 *   name, so the caller loses nothing and the slug stays addressable.
 * - **A face has to be a face.** The manifest types `icon` and `color` as plain
 *   strings, so `"pinkish"` was storable, and a colour stored as `"  #ABC  "`
 *   can never show as selected in the picker, which compares against
 *   `AGENT_COLOR_PRESETS` by string equality.
 * - **A display name has a length the manifest enforces.** `.max(100)` on
 *   `AgentManifestSchema` turns a longer one into a raw Zod failure from
 *   `writeManifest`, several layers below anybody who could explain it.
 *
 * Refusals are returned, never thrown: each caller renders them in its own
 * shape (an MCP error payload, a 400 body) and they read the same either way.
 *
 * @module services/mesh/normalize-agent-identity
 */
import {
  isSingleEmoji,
  isHexColor,
  normalizeHexColor,
  normalizeAgentIcon,
} from '@dorkos/shared/agent-face';
import { slugifyAgentName } from '@dorkos/shared/validation';

/**
 * The longest display name a manifest holds — `AgentManifestSchema.displayName`
 * is `.max(100)`, and this is the same number said where the check happens.
 */
export const AGENT_DISPLAY_NAME_MAX = 100;

/** The identity fields a caller may send on any of the three register paths. */
export interface AgentIdentityInput {
  /** Slug, or a display-style name to derive one from. */
  name?: string;
  /** Human-readable name. Derived from `name` when absent and `name` is display-style. */
  displayName?: string;
  /** Emoji face. */
  icon?: string;
  /** Hex colour. */
  color?: string;
}

/** The normalised fields, ready to spread onto a manifest or an overrides object. */
export interface AgentIdentityFields {
  /** The kebab-case slug. Absent only when the caller named nothing and gave no fallback. */
  name?: string;
  /** The display name, at most {@link AGENT_DISPLAY_NAME_MAX} characters. */
  displayName?: string;
  /** The emoji, trimmed. */
  icon?: string;
  /** The colour, as `#rrggbb`. */
  color?: string;
}

/** Why an identity was refused. Each code names exactly one field. */
export type AgentIdentityErrorCode =
  'INVALID_NAME' | 'INVALID_DISPLAY_NAME' | 'INVALID_ICON' | 'INVALID_COLOR';

/** The outcome: the fields to store, or one refusal a caller can show a person. */
export type AgentIdentityResult =
  | { ok: true; identity: AgentIdentityFields }
  | { ok: false; code: AgentIdentityErrorCode; error: string };

/**
 * Check and normalise the identity fields a caller sent.
 *
 * @param input - What the caller sent. Every field is optional.
 * @param fallbackName - The name to use when the caller sent none, normally the
 *   agent directory's basename. Omit it where the caller's own path already
 *   handles a missing name (adoption ignores every override), and `name` comes
 *   back absent instead of invented.
 * @returns The normalised fields, or the one refusal that stopped them.
 */
export function resolveAgentIdentity(
  input: AgentIdentityInput,
  fallbackName?: string
): AgentIdentityResult {
  const identity: AgentIdentityFields = {};

  const requested = (input.name ?? fallbackName)?.trim();
  if (requested !== undefined) {
    // A slug needs something to be made of. `slugifyAgentName` answers 'agent'
    // for a name with no letters or digits in it, which is a silent rename to
    // a name the caller never chose — worse than saying no.
    if (!/[a-z0-9]/i.test(requested)) {
      return {
        ok: false,
        code: 'INVALID_NAME',
        error:
          `Invalid name ${JSON.stringify(input.name ?? fallbackName)}. A name needs at least ` +
          'one letter or digit: it becomes the immutable slug the agent is addressed by.',
      };
    }
    identity.name = slugifyAgentName(requested);
  }

  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (!displayName) {
      return {
        ok: false,
        code: 'INVALID_DISPLAY_NAME',
        error:
          'A display name cannot be blank. Omit it to take one from the name, or send the ' +
          'name you want people to read.',
      };
    }
    if (displayName.length > AGENT_DISPLAY_NAME_MAX) {
      return {
        ok: false,
        code: 'INVALID_DISPLAY_NAME',
        error:
          `A display name is at most ${AGENT_DISPLAY_NAME_MAX} characters, and that one is ` +
          `${displayName.length}.`,
      };
    }
    identity.displayName = displayName;
  } else if (requested !== undefined && identity.name !== requested) {
    // The caller wrote a label in the slug field. Keep what they wrote, cut to
    // what the manifest holds: truncating is the friendlier half of the same
    // decision that refuses an explicit one, because nobody typed this string
    // as a display name and refusing would fail a call over a long folder name.
    identity.displayName = requested.slice(0, AGENT_DISPLAY_NAME_MAX).trim();
  }

  if (input.icon !== undefined) {
    if (!isSingleEmoji(input.icon)) {
      return {
        ok: false,
        code: 'INVALID_ICON',
        error:
          `Invalid icon ${JSON.stringify(input.icon)}. An agent's icon is exactly one emoji, ` +
          'e.g. "\u{1F52E}". Omit it to have one picked.',
      };
    }
    identity.icon = normalizeAgentIcon(input.icon);
  }

  if (input.color !== undefined) {
    if (!isHexColor(input.color)) {
      return {
        ok: false,
        code: 'INVALID_COLOR',
        error:
          `Invalid color ${JSON.stringify(input.color)}. Use a hex colour like "#ec4899". ` +
          'Omit it to have one picked.',
      };
    }
    identity.color = normalizeHexColor(input.color);
  }

  return { ok: true, identity };
}
