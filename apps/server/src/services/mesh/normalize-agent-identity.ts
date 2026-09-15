/**
 * The one place a caller-supplied agent identity is checked and normalised
 * before it reaches a manifest.
 *
 * Three surfaces let one caller name another agent: the `mesh_register` MCP
 * tool (both servers), `POST /api/mesh/agents`, and `POST /api/agents`. All
 * three used to write whatever they were handed, and all three got it wrong in
 * the same way (DOR-2054):
 *
 * - **`name` is an address, not a label.** It is immutable, and it is what an
 *   agent's `@handle` in a room is derived from
 *   (`services/rooms/author-registry.ts`: `deriveHandle(name) ?? deriveHandle(displayName)`).
 *   DorkBot sent `"DorkOS Cloud"` and the manifest stored that string, spaces
 *   and all. A name with whitespace in it is slugified here and kept as the
 *   display name, so the caller loses nothing and the slug stays addressable.
 *
 *   **Whitespace is the whole test, and it is deliberately narrow.** A name is
 *   a label when it has a space in it and an address otherwise: `AGENT_NAME_REGEX`
 *   forbids whitespace, so nothing that was already a valid slug can be caught
 *   by it. Widening the test to "not already kebab-case" would rewrite names
 *   that work: `slugifyAgentName` flattens `.` and `_` and prefixes a leading
 *   digit, which `packages/shared/src/handle.ts` measured against a real
 *   fleet — `144mono`, `144x.co`, `doriancollier.com` and `next_starter` all
 *   change under it, and `mintHandle` derives from `name` FIRST, so changing
 *   one moves an address somebody already types. A name written entirely
 *   outside the Latin charset (`日本語`, `проект`) is likewise left exactly as
 *   it came: `author-registry.ts` calls such a name an ordinary thing to have,
 *   and its handle falls back to the display name rather than being refused.
 *   Every one of those registers byte-for-byte as it did before this module
 *   existed, and derives the same handle it always did.
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
 * @param input - What the caller sent. Every field is optional; `name` absent
 *   means the caller named nothing, and nothing is invented for them.
 * @returns The normalised fields, or the one refusal that stopped them.
 */
export function resolveAgentIdentity(input: AgentIdentityInput): AgentIdentityResult {
  const identity: AgentIdentityFields = {};

  const requested = input.name?.trim();
  if (requested !== undefined) {
    // Empty is the one name that cannot be stored at all — `registerByPath`
    // has always thrown on it, several layers below anyone who could say why.
    if (!requested) {
      return {
        ok: false,
        code: 'INVALID_NAME',
        error:
          'A name cannot be blank. Omit it to take the directory name, or send the address ' +
          'you want this agent to answer to.',
      };
    }
    // Whitespace, and nothing else, marks a label — see this module's header
    // for the four real addresses that a wider test would have moved. A label
    // with no Latin characters to slugify (a CJK or Cyrillic name with a space
    // in it) is left alone too: there is no slug to make of it, and 'agent' is
    // not a name anybody chose.
    const isLabel = /\s/.test(requested) && /[a-z0-9]/i.test(requested);
    identity.name = isLabel ? slugifyAgentName(requested) : requested;
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
    //
    // `Array.from` rather than `slice`: a cut at a code UNIT can land inside a
    // surrogate pair and write half an emoji to disk, which no renderer can
    // show and no equality check can match.
    identity.displayName = Array.from(requested).slice(0, AGENT_DISPLAY_NAME_MAX).join('').trim();
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

/** The normalised fields for a path that always ends up with a name. */
export interface NamedAgentIdentityFields extends AgentIdentityFields {
  /** The name to store. Always present. */
  name: string;
}

/** {@link AgentIdentityResult} for a caller that supplied a fallback name. */
export type NamedAgentIdentityResult =
  | { ok: true; identity: NamedAgentIdentityFields }
  | { ok: false; code: AgentIdentityErrorCode; error: string };

/**
 * {@link resolveAgentIdentity} for the two creation paths that must end up with
 * a name whatever the caller sent.
 *
 * The fallback is folded into `name` rather than handled separately, so a
 * directory basename is treated exactly as an explicitly sent name is — which
 * matters, because the Discovery view sends the basename AS `overrides.name`
 * (`buildRegistrationOverrides` passes `candidate.hints.suggestedName`, which
 * every strategy sets to `path.basename(dir)`). A rule that only guarded the
 * explicit argument would leave the app's main registration door doing the
 * thing this module exists to stop.
 *
 * It exists for the type as much as the fallback: it narrows `name` to
 * `string`, so no caller has to write a `?? basename` that can never run and
 * would write an unslugified name if it somehow did.
 *
 * @param input - What the caller sent. `name` wins over `fallbackName`.
 * @param fallbackName - The name to use when the caller sent none, normally the
 *   agent directory's basename.
 * @returns The normalised fields with a name, or the refusal that stopped them.
 */
export function resolveNamedAgentIdentity(
  input: AgentIdentityInput,
  fallbackName: string
): NamedAgentIdentityResult {
  const result = resolveAgentIdentity({ ...input, name: input.name ?? fallbackName });
  if (!result.ok) return result;
  const { name } = result.identity;
  if (name === undefined) {
    // Unreachable: a name went in, so a name comes out. Stated as an invariant
    // rather than papered over with a fallback that would write the raw
    // directory name straight past every check above it.
    throw new Error('resolveAgentIdentity returned no name for an input that carried one');
  }
  return { ok: true, identity: { ...result.identity, name } };
}
