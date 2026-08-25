/**
 * What `GET /api/search` answers with, and the two numbers a caller has to
 * respect to ask it politely (message-search spec §6, §7 and Amendment 1).
 *
 * One route, one envelope. A hit is a **coordinate plus an excerpt**: which
 * source, which container, which position in it — enough to open the thing that
 * was said, and deliberately not the thing itself. The index holds a copy of the
 * text and none of the access rules, so resolving a coordinate back to a message
 * stays the owning store's job.
 *
 * `warnings[]` is ADR-0310's envelope, reused rather than reinvented: a source
 * whose indexing failed contributes zero hits and one warning naming it, never a
 * failed request and never a blank list. It differs from
 * `TeamSourceWarningSchema` in one deliberate way — it is always present, `[]`
 * included — because this response is read by a search box that renders the
 * array on every keystroke, and a field that appears only sometimes is one every
 * caller has to remember to default.
 *
 * @module shared/search-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * Split what somebody typed into the words a search will actually look for.
 *
 * **The one tokenizer**, shared by the schema that refuses a query and the
 * server that builds the FTS5 `MATCH` expression out of it — because a minimum
 * length checked against the RAW string is not a minimum at all. `a,` and `%20a`
 * and `a.` are all two or more characters and all one letter of search, and each
 * of them ran the most expensive query there is until this was the thing being
 * measured.
 *
 * It splits on everything that is not a letter, a number or an underscore, which
 * is what `unicode61` does to the same string, so the count here is the count
 * FTS5 will see.
 *
 * @param raw - What the caller typed.
 * @returns The words, in order. Empty when the input holds no word at all.
 */
export function searchTokens(raw: string): string[] {
  return raw.split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length > 0);
}

/**
 * The shortest search DorkOS will run, in characters.
 *
 * **Part of the contract, not a tuning knob** (spec Amendment 1). Ranking is
 * `ORDER BY bm25()`, which is O(matching rows) rather than O(limit) — bm25 has
 * to score every match before `LIMIT` can discard any — so a one-letter query is
 * simultaneously the most expensive one there is and the least useful. Typing
 * `t` → `th` → `the` fires three searches whose cost FALLS as the words get more
 * specific. The floor is what stops a search box paying for the first two.
 *
 * **What the measurement actually showed, because it is not what this comment
 * first claimed.** The obvious story — short queries are the expensive ones, so
 * the floor buys back the cost — is only half true, and the half that is false
 * matters. Measured over 9,207 real messages by `scripts/search-latency-bench.ts`:
 * the worst one-character query (`a`) matches **42%** of the index, the worst
 * two-character one (`it`) **47%**, and the worst three-character one (`the`)
 * **83%**. **Length does not predict cost** — the commonest word in English is
 * three letters long, and no floor short of absurd would refuse it.
 *
 * So this is not a cost threshold, and pretending otherwise would be a number
 * dressed up as a derivation. It is the other half of Amendment 1's argument,
 * which does hold: a one-letter query is **certainly useless AND certainly
 * expensive**, so a box that fires on every keystroke pays worst-case prices for
 * answers nobody wanted. Two is the shortest length people really type meaning
 * something (`db`, `ci`, `pr`); one never is.
 *
 * The bench asserts the fact this rests on rather than the literal — that the
 * queries this floor refuses are expensive ones — so a corpus where that stops
 * being true reddens instead of quietly refusing people for nothing.
 *
 * **It is counted over {@link searchTokens}, never over the raw string**, which
 * is the difference between a floor and the appearance of one.
 */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * How long a caller should wait after the last keystroke before searching, in
 * milliseconds.
 *
 * The other half of the same contract. The server cannot enforce it — it sees
 * requests, not keystrokes — so it is published here as the number every caller
 * uses, rather than rediscovered per surface under a performance bug.
 */
export const SEARCH_DEBOUNCE_MS = 200;

/** How many hits come back when the caller does not say. */
export const SEARCH_DEFAULT_LIMIT = 20;

/**
 * The most hits one request may ask for.
 *
 * The ceiling bounds the `snippet()` work, which is charged per RETURNED row —
 * unlike the ranking, which is charged per matching row and is unaffected by
 * this number.
 */
export const SEARCH_MAX_LIMIT = 50;

/** Who said it. */
export const SearchHitRoleSchema = z.enum(['user', 'assistant']).openapi('SearchHitRole');

/** One message that matched, as a coordinate the owning store resolves. */
export const SearchHitSchema = z
  .object({
    /** Which source it came from — `'rooms'`, `'claude-code'` or `'codex'` today. */
    source: z.string().min(1),
    /**
     * The container it lives in: **opaque, composed per source, never parsed by
     * a reader that did not compose it.** A room id for `rooms`, a session id
     * for `claude-code` and `codex` — and, once community scoping lands, a room
     * id with a community in front of it, with no change to this field's
     * meaning.
     */
    container: z.string().min(1),
    /**
     * The working directory this hit opens in, or `null` for a source that has
     * none (a room is not a directory) and for a container that never named one.
     *
     * A directory that no longer exists is still returned with its path: the
     * conversation happened and the transcript is still readable, so what
     * changes is what the OPEN action reports, not whether the hit is shown
     * (spec §6.4).
     */
    containerPath: z.string().nullable(),
    /** Position within the container — a room entry's `seq`, or the message's index in a transcript. */
    ordinal: z.number().int(),
    role: SearchHitRoleSchema,
    /** ISO-8601, or `null` for a source that records no timestamp. */
    createdAt: z.string().nullable(),
    /**
     * The matching words in their sentence, with every match wrapped in
     * `<mark>…</mark>` and long text elided with `…`.
     *
     * **This is TEXT, not HTML.** The marks are the only markup in it and
     * everything around them is whatever was typed, `<script>` included — so a
     * renderer escapes the text and re-applies the marks, never assigns it to
     * `innerHTML`.
     */
    excerpt: z.string(),
  })
  .openapi('SearchHit');

/** One message that matched (see {@link SearchHitSchema}). */
export type SearchHit = z.infer<typeof SearchHitSchema>;

/**
 * One source that could not be fully indexed, so its part of the answer may be
 * missing rows.
 *
 * Deliberately says nothing about WHICH container failed. A container id is a
 * room id or a session id, and naming one in a response that anybody may ask for
 * would turn this envelope into the probe §9.5 forbids.
 */
export const SearchSourceWarningSchema = z
  .object({
    /** The source that is behind — `'rooms'`, `'claude-code'`, `'codex'`. */
    source: z.string().min(1),
    message: z.string().min(1),
  })
  .openapi('SearchSourceWarning');

/** One source that could not be fully indexed (see {@link SearchSourceWarningSchema}). */
export type SearchSourceWarning = z.infer<typeof SearchSourceWarningSchema>;

/**
 * The `GET /api/search` envelope.
 *
 * `results` is ranked best first across every source the caller may read — one
 * ranking, not one list per source, because "where did we talk about X" does not
 * know which source X was said in.
 */
export const SearchResponseSchema = z
  .object({
    results: z.array(SearchHitSchema),
    /** Empty when every source is caught up. Always present. */
    warnings: z.array(SearchSourceWarningSchema),
  })
  .openapi('SearchResponse');

/** The `GET /api/search` envelope (see {@link SearchResponseSchema}). */
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * The query string `GET /api/search` accepts.
 *
 * `limit` is CLAMPED rather than refused, matching `read_room_history`: a caller
 * asking for a thousand gets {@link SEARCH_MAX_LIMIT}, because refusing a number
 * is a worse answer than giving the most that is sensible. `q` is the one thing
 * that is refused, and only below {@link SEARCH_MIN_QUERY_LENGTH} — see the
 * constant for why that is a contract rather than an optimisation.
 */
export const SearchQuerySchema = z
  .object({
    /**
     * What the caller typed. Matched by word STEM, never by substring.
     *
     * Refused when it holds no WORD of at least {@link SEARCH_MIN_QUERY_LENGTH}
     * characters — so `a,`, `%20a` and a string of spaces are all refused, and
     * all three reached the ranked query while this was a `.min()` on the raw
     * string.
     */
    q: z
      .string()
      .refine((raw) => searchTokens(raw).some((token) => token.length >= SEARCH_MIN_QUERY_LENGTH)),
    /** How many hits to return, clamped to {@link SEARCH_MAX_LIMIT}. */
    limit: z.coerce.number().int().positive().optional(),
    /** Narrow to one source. Omitted searches every source the caller may read. */
    source: z.string().min(1).optional(),
  })
  .openapi('SearchQuery');

/** The `GET /api/search` query string (see {@link SearchQuerySchema}). */
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
