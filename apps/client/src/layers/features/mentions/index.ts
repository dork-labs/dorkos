/**
 * Mentions feature — the `@` picker that addresses an agent, notifies a person,
 * and makes what the server resolves the same string the composer wrote
 * (spec `room-participation` §10.1).
 *
 * @module features/mentions
 */
export { MentionPalette } from './ui/MentionPalette';
export { useMentionAutocomplete } from './model/use-mention-autocomplete';
export type { MentionRow } from './lib/mention-rows';
