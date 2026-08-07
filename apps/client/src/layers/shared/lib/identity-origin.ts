/**
 * Where a human participant is posting from — shared by every identity
 * surface that draws a platform glyph for a bridged (external) person.
 *
 * A type and nothing else, and it lives in `lib` rather than beside the
 * components that read it: `identity-face.ts` needs it too, and `lib`
 * reaching into `ui` for a type is the wrong direction for the one dependency
 * `ui` already has on `lib`.
 *
 * @module shared/lib/identity-origin
 */

/**
 * `'local'` (or omitted) means the person is on this machine. `{ platform }`
 * means the room bridged them in from somewhere else — Telegram, Discord,
 * whatever the adapter names — and the platform glyph {@link MentionPill}
 * and {@link IdentityHoverCard} draw for it is a stand-in until a
 * per-platform icon map exists.
 */
export type IdentityOrigin = 'local' | { platform: string };
