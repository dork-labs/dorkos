/**
 * The one sentence every skill that names a DorkOS tool has to carry (DOR-1292).
 *
 * These skills are projected into `.claude/skills/` for EVERY harness — Claude
 * Code, Codex, OpenCode — and none of the three agrees on what a DorkOS tool is
 * called. Claude Code qualifies its in-session server's tools as
 * `mcp__<server>__<tool>`; Codex and OpenCode reach the same tools through the
 * external `/mcp` server, under whatever name the person's own harness config
 * gave it. A bare name is therefore uncallable on one runtime and unreliable on
 * the other two.
 *
 * Rewriting these documents into verb phrases ("the create-schedule tool") was
 * the alternative and it is worse: the names ARE the payload of a reference doc,
 * and a model that cannot search for a token cannot find the tool. Naming them as
 * ENDINGS keeps every name intact while being true on all three runtimes, so this
 * note is what makes the rest of the page honest.
 *
 * `context-tool-names.test.ts` fails if any skill names a DorkOS tool without it.
 *
 * @module tool-name-note
 */

/**
 * The prefix disclaimer, prepended to every skill body that names tools.
 *
 * Kept as one shared string rather than copied into six documents so it cannot
 * drift into six slightly different claims about the same fact.
 */
export const TOOL_NAME_NOTE = `> Every tool name below is an ENDING: your harness prefixes it. Search for the ending, call what your tool list shows.`;
