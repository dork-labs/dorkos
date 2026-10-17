/**
 * Mentions feature — the `@` picker that addresses an agent, notifies a person,
 * and makes what the server resolves the same string the composer wrote
 * (spec `room-participation` §10.1).
 *
 * The picker's state and rows live in `entities/room`
 * (`useMentionAutocomplete`, `MentionRow`), so every surface that writes a
 * mention, a room composer or a doc comment, shares one model; this feature is
 * the palette that draws them.
 *
 * @module features/mentions
 */
export { MentionPalette } from './ui/MentionPalette';
