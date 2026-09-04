/**
 * The `rooms` suite's JUDGMENT tier — what a real model does once the room stops
 * speaking for it (spec `tool-only-room-replies` §D13; DOR-1613 PR3).
 *
 * Twelve credentialed cases, every one of them quarantined, every one of them
 * driving `rooms.toolOnlyReplies` ON before it posts. They spend real money and
 * they are not a check.
 *
 * ## What separates this file from `rooms.ts` and `rooms-tool-only.ts`
 *
 * Those measure MECHANISM on `test-mode`: given a scripted turn that posts, or
 * reacts, or says nothing, does the room do the right thing? They gate, they are
 * free, and they can never be wrong about a model because no model is involved.
 *
 * This file measures JUDGMENT. The flip's whole premise is that an unmade tool
 * call is a mechanism where "only speak when it matters" is a prompt — but the
 * mechanism only buys the OPPORTUNITY to choose well. Whether a model actually
 * answers the person who asked, and actually stays out of the conversation that
 * is not about it, is conduct, and conduct can only be measured against a real
 * model. `.claude/rules/room-conduct.md` draws exactly this line: "Do I run a
 * turn?" is deterministic code, "Do I say something?" is conduct.
 *
 * ## The one number that decides whether this suite is worth its cost
 *
 * **DM answer-rate.** The flip's honest price is that it adds a way for a reply
 * to go missing (§2.6's third clause, which the ADR keeps rather than answers
 * away), and a direct message is where that costs most: there is nobody else the
 * question could have been for. Three phrasings measure it — a direct question,
 * an ambiguous request, and a statement that implies one — and a fourth case
 * measures RESTRAINT on a bare "thanks", because without it the DM suite is a
 * check that cannot fail: an agent that answers everything scores 100%.
 *
 * ## How the operator runs these
 *
 * NOT `pnpm evals:local` — that is `--suite core`, and nothing here carries the
 * `core` tag (the registry test polices it, because a rooms case that drifted
 * into `core` would bill every local run for something meant to be free). The
 * invocation is explicit:
 *
 * ```bash
 * pnpm --filter @dorkos/evals run evals -- \
 *   --suite rooms --tier claude-code-cheap --isolation child-process --budget 2
 * ```
 *
 * `--isolation child-process` is not a default and is not optional: the docker
 * tier seals the container off from the home directory, so it cannot see the
 * `claude` sign-in these cases bill against (README, "Where a credential comes
 * from"). `--budget 2` is a statement of intent rather than an enforced cap —
 * a rooms case reports `unmetered` honestly, because the cost signal rides the
 * per-SESSION stream while a room drive collects the ROOM's. What actually
 * bounds a case here is {@link CREDENTIALED_TIMEOUT_MS}, five minutes per drive.
 *
 * Measured shape: twelve cases at the $0.038–$0.057 per case this package has
 * measured on Haiku is **$0.45–$0.70 a run**.
 *
 * **Those figures, and every pass rate below, were measured before DOR-1712** —
 * that is, while each turn was still reading the operator's own user-level
 * `~/.claude` (settings, `CLAUDE.md`, skills) on top of the room context these
 * cases are about. The harness now pins a controlled `CLAUDE_CONFIG_DIR`
 * whenever the run can authenticate without the real one
 * (`runner/claude-config.ts`), and the numbers here have NOT yet been re-measured
 * under it. Read them as this-machine numbers until they are: the drills, which
 * change one variable on one machine, are unaffected either way; the absolute
 * rates and the per-case dollars are what may move.
 *
 * ## Every case here owes a drill, and the DM one is mandatory
 *
 * A green from a model is not evidence that a FEATURE works — it may be evidence
 * that the model would have done the right thing anyway. The drill is what tells
 * those apart, and the spec names one specifically:
 *
 * > Strip the flag-ON "in a DM with a person, always answer" line from the room
 * > context and re-run — answer-rate must measurably drop. If it does not, the
 * > eval measures the model's disposition rather than this feature and its green
 * > means nothing.
 *
 * That recipe is written out below, in the five parts the README requires, with
 * the red it actually produced. Which drills have been RUN
 * live and which are recipes waiting for a run is recorded per case, honestly —
 * a recipe nobody has executed is a hypothesis.
 *
 * **A stated deviation from the spec.** §D13 asks for one drill per oracle. Six
 * cases here carry a written recipe (the three DM answer-rate cases via the DM
 * recipe below, DM restraint, the channel floor, and ambient silence). Six do
 * NOT: `rooms-channel-yields-when-a-human-answered`,
 * `rooms-ack-only-reacts-under-the-flip`,
 * `rooms-dm-reaction-can-be-the-whole-answer`,
 * `rooms-thinking-stays-in-the-session`,
 * `rooms-answers-three-questions-in-one-message`, and
 * `rooms-declines-visibly-rather-than-vanishing`. The reason is not budget: with
 * the suite failing for a reason upstream of any individual oracle — the model
 * narrates instead of calling the tool — a mutation on any of those six would
 * red for that reason rather than for the one the recipe names, which is a drill
 * that proves nothing while looking like it proved something. They are owed when
 * the cases can go green, and that is the honest state of it rather than a claim
 * the spec was met.
 *
 * ### The DM drill, in the five parts the README requires
 *
 * 1. **The seed.** In `apps/server/src/services/runtimes/shared/room-context-block.ts`,
 *    delete the `data.replyMode === 'tool-only'` push at the END of
 *    `formatRoomContext` — the closing directive, "Before you end this turn,
 *    exactly one of these two". **Not the D11 paragraph this step used to name.**
 *    That paragraph was present, and reworded to state the association outright,
 *    through every one of the DOR-1643 failing runs; the directive is what
 *    carries the behaviour, and seeding the paragraph now would be a drill that
 *    reds for nothing and proves nothing.
 * 2. **The command**, in full. `--isolation child-process` is load-bearing: the
 *    docker tier cannot see the local `claude` sign-in.
 *
 *    ```bash
 *    pnpm --filter @dorkos/evals run evals -- \
 *      --suite rooms-dm-answers-a-direct-question \
 *      --tier claude-code-cheap --isolation child-process --budget 1
 *    ```
 *
 *    Repeat for `rooms-dm-answers-an-ambiguous-request` and
 *    `rooms-dm-answers-an-implied-question`.
 * 3. **What to expect, structural versus variable.** STRUCTURAL: the turn still
 *    runs — the mention is not what is being removed — so `roomTurnRanFor` stays
 *    green in every outcome. VARIABLE, and the whole point: whether
 *    `agentPostedInRoom` goes red depends on what the model chose without the
 *    instruction. A single red across the three phrasings is a measurable drop;
 *    three greens is the result that matters most, because it says the eval is
 *    reading the model's disposition rather than this feature.
 * 4. **Reproduction versus noise.** A reproduction has the turn RUNNING and the
 *    post absent. A run where `roomTurnRanFor` is also red proved nothing — the
 *    turn never started, which on a loaded machine is the common failure (the
 *    A-06 case has one recorded) and should simply be repeated.
 * 5. **Where to read the answer.** `results.json` in the run directory. Selecting
 *    only quarantined cases always exits non-zero, so the exit code says nothing.
 *
 *
 * ## What closed the inversion (2026-09-02, DOR-1643)
 *
 * The findings below stand as the record of what was measured on 2026-08-29 and
 * why. **They describe the prompt as it was, not as it is.** The inversion they
 * name was closed by a prompt change in
 * `apps/server/src/services/runtimes/shared/room-context-block.ts`, and what
 * closed it is worth more than the fix: three rewords that were all *true*
 * changed nothing at all.
 *
 * - Stating the association in prose — "the answer you formed is the thing you
 *   post", in both `buildToolOnlyBlock` and the D11 DM line — did not move it.
 *   The turn still wrote a complete answer with zero tool calls.
 * - Restating it as the LAST line of `<room_context>`, where nothing sits
 *   between it and the person's message, did not move it either.
 * - Naming the tool in that line (`mcp__dorkos__post_to_room`, via a prefix the
 *   adapter supplies) did not move it.
 * - Spelling the CALL, with this room's id already in it —
 *   `…post_to_room(roomId: "01M…", text: <your answer>)` — moved it on the first
 *   try, and the turn that had taken 41s to narrate posted in 13s.
 *
 * So the gap was never comprehension. A model that has decided its answer is
 * written still has to assemble a call to send it, and every step between
 * deciding and calling is a step at which it stops. Removing the assembly is
 * what worked.
 *
 * Two further things were paid for in reds, and both are ordering rather than
 * content. A single unconditional imperative answered a bare "thanks!" with
 * "Welcome! Let me know if you want to dig into the importer details." —
 * the pleasantry, reproduced. Inverting it so the exception came first restored
 * restraint and lost the answer. Neither ordering is the fix: the directive is
 * now TWO branches, each ending in its own concrete action, with the answering
 * one last. And the quiet branch quotes the phrasings it forbids, because
 * "post nothing" lost twice to a model that did not count a warm sign-off as a
 * message.
 *
 * **The CHANNEL quiet branch is gated on `addressing.addressedNow`**, which is a
 * review finding rather than a measured one and is worth marking as such. "You
 * have nothing to add: post nothing, and end the turn." is right for the
 * overheard conversation E7 makes silence free in; read from the last line
 * before a message that just NAMED the agent, it licenses the disappearing act
 * `specs/room-participation` is written against. The addressed branch still
 * allows a reaction — A-06 needs "just ack this" answerable with one emoji and
 * nothing else — and forbids only vanishing.
 *
 * ### The post-review confirmation round (2026-09-02, after the addressing gate)
 *
 * Twelve cases, one run each: **9 pass, 3 red, and none of the three reds is the
 * behaviour its case is named for.**
 *
 * | Case | Result | Why |
 * | ---- | ------ | --- |
 * | the three DM answer-rate seeds | **3 of 3 pass** | — |
 * | `rooms-dm-restraint-on-a-bare-thanks` | red | ONLY `openerLanded` failed; the restraint oracle passed and nothing was posted after "thanks!". The unanswerable-opener defect, twice over |
 * | `rooms-channel-mentioned-question-posts` | pass | — |
 * | `rooms-channel-yields-when-a-human-answered` | red | the sandbox confound: the agent posted "This is a greenfield project so I'm starting fresh", which is the host machine's `SessionStart` hook talking, not conduct |
 * | `rooms-ack-only-reacts-under-the-flip` | pass | — |
 * | `rooms-dm-reaction-can-be-the-whole-answer` | pass | — |
 * | `rooms-thinking-stays-in-the-session` | pass | — |
 * | `rooms-answers-three-questions-in-one-message` | pass | — |
 * | `rooms-ambient-silence-is-free-for-a-model-too` | red | the restraint oracle PASSED — the transcript reasons "they're not asking me anything… I should post nothing and end the turn", which is the unaddressed quiet branch working. Its OPENER narrated instead of posting |
 * | `rooms-declines-visibly-rather-than-vanishing` | pass | — |
 *
 * **The ambient red is the one worth not explaining away.** It is the narration
 * failure, appearing once on an ADDRESSED channel message, in a round where the
 * three sibling addressed-channel cases all posted through the tool. The
 * addressing gate is not what produced it: the branch that gate changed forbids
 * bare silence *more* strongly than the text it replaced, and the outcome was
 * neither branch. One instance is not a rate, and the honest reading is that the
 * channel speak branch is weaker than the DM one — it lacks the DM's "that call
 * is the only thing they will ever see" — and may want the same force. That is a
 * hypothesis with one data point behind it, not a finding.
 *
 * **Where DM answer-rate stands: 3 of 3 seeds, three separate rounds, plus a
 * standalone green on the direct-question seed.** DM restraint is the softer
 * number — 4 passes, 3 fails and one 313s harness timeout across the whole
 * iteration — and its case carries a defect of its own that is nobody's conduct:
 * its OPENER ("did the importer fix go out in yesterday's release?") is not
 * answerable from the message, so a sandbox agent that correctly says nothing
 * trips `openerLanded` before restraint is ever measured. That accounts for its
 * last two reds outright — in both, the restraint oracle itself passed. It is the
 * same defect this file already records against two other cases, and it is owed
 * the same fix; until it is paid, this case's number understates the behaviour.
 *
 * ### The mutation drill, run live (DOR-1643)
 *
 * Deleting the closing directive — the `data.replyMode === 'tool-only'` push at
 * the end of `formatRoomContext` — and re-running the three answer-rate seeds
 * took them from 3 of 3 to 1 of 3: `rooms-dm-answers-a-direct-question` red,
 * `rooms-dm-answers-an-ambiguous-request` red, `rooms-dm-answers-an-implied-question`
 * green. `roomTurnRanFor` stayed green in every one, so each red is the post
 * missing rather than the turn never starting. A measurable drop, which is what
 * the recipe below asks for — and note it is now the CLOSING DIRECTIVE that the
 * drill has to seed, not the D11 paragraph the recipe names: the paragraph was
 * present and strengthened through all three of the failing runs above.
 *
 * ## What the first live runs measured (2026-08-29, `claude-code-cheap` / Haiku)
 *
 * **Graduation criteria 2 and 3 were NOT met then, and the reason is sharper than
 * "the model is bad at this".** Seven credentialed runs, every one on
 * `claude-haiku-4-5` through `local-claude-login` (both fields are in each
 * `results.json`). Every one reported `unmetered` — a rooms drive collects the
 * ROOM stream and the cost signal rides the per-SESSION one, so the harness
 * genuinely cannot see it. The ~$0.25 quoted anywhere for this work is INFERRED
 * from this package's measured $0.038–$0.057 per core case on Haiku, not read off
 * a meter.
 *
 * Each row names its run directory under `packages/evals/.evals-runs/`, so every
 * claim below is checkable against a `.jsonl` rather than believed.
 *
 * | Run | Directory | Case | Flip | Result |
 * | --- | --------- | ---- | ---- | ------ |
 * | 1 | `2026-08-29T08-12-23-090Z` | `rooms-dm-answers-a-direct-question`, unanswerable phrasing ("is the importer finished, or is it still failing on the CSV headers?") | ON | FAIL — turn ran 11.2s, `outcome: 'silent'`, room wrote the decline |
 * | 2 | `2026-08-29T08-14-54-328Z` | same, reworked to carry its own facts | ON | FAIL — turn ran, `outcome: 'silent'`, same |
 * | 3 | `2026-08-29T08-16-29-169Z` | same, **control** | OFF | **PASS** — case took 15.0s, the agent answered |
 * | 4 | `2026-08-29T08-18-17-846Z` | `rooms-channel-mentioned-question-posts`, asking "which rows is the importer dropping, and why?" | ON | FAIL — but **discounted**: the question was unanswerable, so the red cannot separate "did not answer" from "could not" |
 * | 5 | `2026-08-29T08-18-58-025Z` | `rooms-dm-restraint-on-a-bare-thanks` | ON | FAIL — see below |
 * | 6 | `2026-08-29T08-44-57-931Z` | `rooms-channel-mentioned-question-posts`, **still the unanswerable question** | ON | FAIL — turn ran 12.8s (case 35.5s), reached for `search_room_history` and `read_room_history`, posted nothing, room wrote the decline. A repeat of run 4, and discounted for the same reason |
 * | 7 | `2026-08-29T09-00-18-112Z` | `rooms-channel-mentioned-question-posts`, question now self-contained | ON | **PASS** — turn ran, reached for `post_to_room`, one answer landed 11.3s in; all three oracles green, `agent_declined` count 0 |
 *
 * Tool NAMES in those two rows come from the turn's progress signals, which say
 * which tool a turn is inside rather than how many times it called one — the
 * README's "frames are not calls" caveat applies, so no row here counts calls.
 * Posts are counted, because an entry frame is one post.
 *
 * **Run 7 is the one that reframed everything, and rows 4 and 6 are why the
 * bookkeeping matters.** Both of those runs were recorded as evidence about the
 * channel floor, and an earlier version of this table described run 6 as having
 * used a self-contained question. It had not: its `.jsonl` posts
 * `"@ada which rows is the importer dropping, and why?"`, byte-identical to run
 * 4's. Two runs of the same flawed case are one discounted result looked at
 * twice. Run 7 is the first channel run whose message carries its own facts —
 * `"@ada last night's importer log rejected 12 rows: 9 of them failed on a
 * semicolon in the address field and 3 on an empty postcode. Which of those two
 * should we fix first?"` — and it PASSED.
 *
 * **The tool is present and callable**, which run 5 settles: its second turn
 * called `mcp__dorkos__post_to_room` successfully. So this is not the mute the
 * fail-open design guards against, and not a wiring gap.
 *
 * **What the run artifacts can and cannot show about the prompt.** A rooms
 * `.jsonl` under `.evals-runs/` holds the room's SSE frames and the oracle
 * verdicts — run 2's is eleven lines: case meta, six frames, the room facts,
 * three oracle verdicts. It does not
 * record the turn's prompt, so no grep over it can say whether an instruction
 * reached the model, in either direction. The claim that the DM instruction
 * arrived rests on READING the two guards instead, and both fire for a DM under
 * the flip:
 *
 * - `room-tools-context.ts:199`, inside `buildToolOnlyBlock` — "When somebody
 *   ASKED you … answering is not optional". The whole block is emitted only when
 *   the reply mode is `tool-only`;
 * - `room-context-block.ts:1004`, inside the
 *   `replyMode === 'tool-only' && room.kind !== 'channel'` guard — "This is a
 *   direct message, so answering is not optional".
 *
 * Two conditional SOURCE sites whose conditions a DM under the flip satisfies is
 * a weaker claim than an observation of the prompt, and it is the one the
 * evidence supports. Recording the prompt into the transcript is what would make
 * it observable, and no case here does that today.
 *
 * **What the model actually does is the finding, and it is an inversion — in
 * DIRECT MESSAGES.** What the run directories show: run 2 has ZERO activity
 * frames (no tool call), `outcome: 'silent'`, and the decline line written;
 * run 5's second turn carries a `post_to_room` activity and the pleasantry
 * entry "You got it. Let me know if you find out whether it shipped!" in reply
 * to a bare "thanks". That the dropped turns contained complete written answers
 * — narration, not nothing — is a live observation of the session transcripts
 * made while the sandboxes still existed (since deleted), the same evidence
 * class as the prompt claim above: recorded here, not checkable from
 * `.evals-runs/`. The wire outcome enum cannot make the distinction
 * (`'silent'` covers narrated-and-dropped and produced-nothing alike).
 *
 * So in a DM under the flip this model reaches for the tool to be sociable and
 * narrates when it has something to say. That is the precise inverse of what the
 * feature wants, and it means criterion 2 (answer-rate) and criterion 3
 * (restraint) fail in the SAME direction rather than trading off — which is more
 * actionable than either failing alone, because it says the problem is the
 * association between "I have an answer" and "I must call a tool", not the
 * model's judgment about when to speak.
 *
 * ### The inversion is DM-only on the evidence, and the channel-wide reading is
 * withdrawn
 *
 * An earlier version of this doc read runs 4 and 6 as showing the same inversion
 * in a channel, which would have made it a property of the flip rather than of
 * the room kind. **That claim is retracted.** Both of those runs asked a question
 * the agent had no way to answer, and run 6's `.jsonl` shows what an agent does
 * with one: it called `search_room_history` and `read_room_history`, found
 * nothing, and went silent. That is a correct outcome for an unanswerable
 * question, not an inversion.
 *
 * Run 7 changed only the message — same case, same model, same credential, same
 * flip ON — and the agent called `post_to_room` and answered. So on the evidence
 * that exists today:
 *
 * - the inversion is measured in DIRECT MESSAGES, and it rests on runs 2 and 5 —
 *   the two DM runs that can carry it. Run 2 wrote a complete answer as text with
 *   zero tool calls, and run 5 used the tool for a pleasantry. **Run 1 is not
 *   counted either**, and the same rule is why: its question was unanswerable, so
 *   its red says no more about the DM floor than run 4's says about the channel
 *   one. Applying the correction to the channel and not to the DM would be
 *   keeping the convenient half of it;
 * - in a CHANNEL, one mentioned self-contained question was answered through the
 *   tool on the first attempt. One run is not a rate, and it is not a promotion —
 *   this case stays quarantined and the bar is still three green runs — but it is
 *   enough to refute "channel-wide";
 * - and the localisation is sharper for it. `buildToolOnlyBlock` is emitted for
 *   BOTH room kinds and the channel run answered under it, so whatever inverts
 *   the DM is not that block alone.
 *
 * Anywhere outside this file that describes the inversion as channel-wide —
 * tracker issues included — is describing runs 4 and 6 and needs the same
 * correction.
 *
 * ### How to run a case with the flip OFF (the control)
 *
 * Run 3 is the control the whole reading rests on, and it was produced by hand —
 * editing {@link TOOL_ONLY_WHILE_DRIVING} to `false` and re-running. That is a
 * recipe now rather than a thing somebody has to reconstruct:
 *
 * 1. **The seed**: set `TOOL_ONLY_WHILE_DRIVING` to `false` in this file.
 * 2. **The command**: the same one the module doc gives, narrowed to one case
 *    with `--suite <case-id>`.
 * 3. **What to expect**: the case behaves as it did before DOR-1613 — the turn's
 *    text posts, so any answer-rate case should PASS. A red here means something
 *    other than the flip is wrong.
 * 4. **Reproduction versus noise**: the run is only a control if the turn RAN.
 *    Check `roomTurnRanFor` is green before reading anything else.
 * 5. **Where to read the answer**: `results.json`.
 *
 * Note that the unit test `drives the flip ON` fails while the seed is in place,
 * which is deliberate: it is the guard that stops the seed being committed. The
 * restore inside {@link underTheFlip} is a literal `false` for this recipe's
 * sake: written as the negation of {@link TOOL_ONLY_WHILE_DRIVING} it turned the
 * flip back ON after every case, which is exactly backwards for the one person
 * this recipe is for.
 *
 * **What this suite was for at that point**: it was the instrument that said the
 * flip must not graduate yet, and it said where to look — the DM path
 * specifically, since run 7 shows a mentioned channel question answered through
 * the tool under the same block. Run 3 is the control that keeps the reading
 * honest: the same agent, same question, flip off, answers in 15 seconds. That
 * is what it was for, and it did it: DOR-1643 is the work it pointed at, and the
 * section at the top of this doc is what came back. **It does not clear
 * graduation** — criterion 2 is written across all THREE runtimes, and only
 * claude-code has been measured; the Codex and OpenCode legs need their own
 * `DORKOS_EVALS_PAID_PROVIDER` authorization.
 *
 * **Which drills ran live**: the DM mandatory drill ran on 2026-09-02, against
 * the closing directive rather than the D11 paragraph, and took answer-rate from
 * 3 of 3 seeds to 1 of 3 — recorded at the top of this doc. Until then it was
 * *superseded* by a stronger control, and the reason it was is worth keeping:
 * answer-rate was 0 of 2 DM runs WITH the instruction, so the mutation had no
 * headroom and would have been a drill against a floor. Run 3 (flip OFF) was the
 * discriminating control it was reaching for. Once the cases went green the
 * recipe became meaningful again, which is exactly when it was paid for. Every
 * other case's drill is specified and NOT run live — including the channel
 * floor's, whose case now passes: a mutation drill there has become meaningful
 * and is the next one worth paying for, since a green that survives having its
 * instruction removed is a green about the model rather than about the feature.
 *
 * @module evals/suite/rooms-judgment
 */
import type { EvalCase, RoomScriptResult } from '../types.js';
import { postToRoom, setToolOnlyReplies } from '../runner/room-drive.js';
import {
  agentPostedInRoom,
  agentStayedQuietInRoom,
  agentReactedInRoom,
  agentPostCount,
  noRoomEntryContains,
  observedEntries,
  roomNoticeCount,
  roomTurnRanFor,
  somethingVisibleLanded,
} from '../oracles/rooms.js';
import {
  CREDENTIALED_CEILING_USD,
  CREDENTIALED_QUIET_MS,
  CREDENTIALED_TIMEOUT_MS,
  agentSpoke,
  mentionOf,
  openRoomFor,
  openerLanded,
  seedRoomAgents,
} from './rooms-setup.js';
import type { RoomAgentSpec } from './rooms-setup.js';

/**
 * The three DM answer-rate seeds, as data a test can reach.
 *
 * **Exported because the guard that they stay DISTINCT could not otherwise be
 * written honestly.** The first attempt compared case TITLES, which is a
 * different string that happens to differ — rewriting all three questions to be
 * byte-identical left it green. Criterion 2 asks for 100% across three seeds; if
 * the seeds converge, the count is satisfied while one phrasing is measured, and
 * the case list would still look like three.
 *
 * `EvalCase.prompt` cannot carry them — this file's own registry test requires it
 * to be `''` for every rooms case, because a rooms case is driven by a script
 * rather than by a prompt — so the seeds live here.
 */
export const DM_ANSWER_RATE_SEEDS: Readonly<Record<string, string>> = {
  /** A question mark, one subject, nothing to hide behind. */
  'rooms-dm-answers-a-direct-question':
    'the importer dropped 12 rows overnight, all of them with a semicolon in the address ' +
    'field. Should I hold this morning’s release, or ship it and fix forward?',
  /** Not grammatically a question, and readable as "go away and work". */
  'rooms-dm-answers-an-ambiguous-request':
    'the importer is dropping rows with semicolons in the address field — can you take a ' +
    'look at that when you get a chance',
  /** A bare statement. The hardest, and the closest to how people write in a DM. */
  'rooms-dm-answers-an-implied-question':
    'the importer is still dropping every row with a semicolon in it, three days after we ' +
    'thought that one was fixed.',
};

/**
 * The agent every case here seats, `always` so a DM reaches it without an `@`.
 *
 * A DM seeds `always` by default anyway (`.claude/rules/room-conduct.md`: "the
 * DM seed is the agent's `always` default"), and the channel cases mention it
 * explicitly, so one spec serves both and neither depends on the room kind's
 * seeding to be what it is today.
 */
const ADA: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: 'Works on the importer with this team, and answers questions about it.',
  responseMode: 'always',
};

/** The same agent seated `engaged`, which is the channel default. */
const ADA_ENGAGED: RoomAgentSpec = { ...ADA, responseMode: 'engaged' };

/**
 * Turn the flip on for one case, and put it back afterwards.
 *
 * **Every case in this file owes the restore**, and on this tier the reason is
 * sharper than tidiness: the credentialed runner boots a child-process server
 * per case but the sandbox `DORK_HOME` can outlive one, so a flag left on would
 * reach a neighbour that never asked for it — and a neighbour running under the
 * flip when its author wrote it for the old behaviour is a false result in
 * whichever direction it happens to fall.
 *
 * @param baseUrl - The running harness server.
 * @param body - The drive itself.
 */
async function underTheFlip<T>(baseUrl: string, body: () => Promise<T>): Promise<T> {
  await setToolOnlyReplies({ baseUrl, on: TOOL_ONLY_WHILE_DRIVING });
  try {
    return await body();
  } finally {
    // **Back to OFF, written as a literal, which is the shipped default and what
    // every neighbour in this package was written against** — not "whatever it
    // was before", and NOT the negation of {@link TOOL_ONLY_WHILE_DRIVING}. That
    // negation restored the flip to ON for anyone following this module's own
    // flip-OFF recipe, which is the one time the restore has any work to do. A
    // credentialed case boots its own child-process server on a fresh sandbox, so
    // there is no operator setting here to preserve; restoring a value read from
    // the sandbox would only ever restore the default the long way round, while
    // quietly making the case depend on a read that can fail.
    await setToolOnlyReplies({ baseUrl, on: false });
  }
}

/**
 * What {@link underTheFlip} sets, named so a test can assert the direction.
 *
 * **A constant rather than a literal, because the literal was untestable.** With
 * `on: true` written inline, flipping it to `false` left every test in this
 * package green — the cases would have run against the OLD behaviour and
 * reported judgment findings about a feature that was switched off.
 */
export const TOOL_ONLY_WHILE_DRIVING = true;

/**
 * One DM answer-rate probe: open a direct message, say one thing, and collect.
 *
 * The three phrasings differ ONLY in the sentence, which is what makes them
 * three seeds of one measurement rather than three different tests. Graduation
 * criterion 2 asks for 100% on direct questions across three seeds and all three
 * runtimes; the seeds are here, and the runtimes are a run discipline for the
 * dogfood machine rather than nine cases in a file.
 *
 * **Every phrasing is ANSWERABLE FROM THE MESSAGE ITSELF, and that was learned
 * by running it wrong.** The first version asked "is the importer finished, or
 * is it still failing on the CSV headers?" of a fresh sandbox agent with no way
 * to know either — and it failed, live, on 2026-08-29: the turn ran for 11.2
 * seconds, released `outcome: 'quiet'`, and the room wrote "Ada read this and
 * did not reply." The MECHANISM was flawless; the case was not. A question the
 * agent cannot answer measures knowledge and obligation at once and cannot tell
 * which one failed, so a red says nothing about answer-rate.
 *
 * So each of the three carries its own facts and asks for a judgement on them.
 * The only reason left to say nothing is failing the obligation, which is the
 * one thing criterion 2 counts. The unanswerable question did not go to waste —
 * it is {@link roomsDeclinesVisiblyCase}, where BOTH honest outcomes pass and
 * silence-with-no-notice is the only failure.
 *
 * **Two cases in this file still carry the defect, and they are named here so
 * nobody has to rediscover it from a red.**
 * {@link roomsAnswersInOneMessageCase} asks "is the importer green, did the CSV
 * fix ship, and who is on call this weekend?", and
 * {@link roomsThinkingStaysPrivateCase} asks which of three open importer bugs
 * to take first without saying what any of them are. A fresh sandbox agent knows
 * none of that, so a red in either measures knowledge as much as the conduct the
 * case is named for. Neither is rewritten here: both are quarantined, neither
 * has been run live, and the fix belongs with the run that would read it.
 *
 * @param id - The case id.
 * @param title - The case title.
 * @param says - What the person writes into the DM.
 */
function dmAnswerRateCase(id: keyof typeof DM_ANSWER_RATE_SEEDS, title: string): EvalCase {
  const says = DM_ANSWER_RATE_SEEDS[id];
  return {
    id,
    title,
    prompt: '',
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    tags: ['rooms', 'experimental'],
    quarantined: true,
    perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
    seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
    roomScript: async (ctx): Promise<RoomScriptResult> =>
      underTheFlip(ctx.baseUrl, async () => {
        const { room, stream } = await openRoomFor(ctx, {
          slug: id,
          title,
          agents: [ADA],
          kind: 'dm',
          timeoutMs: CREDENTIALED_TIMEOUT_MS,
        });
        try {
          // No mention: in a DM every message a person sends is addressed to
          // whoever is on the other side, and needing an `@` would make this a
          // test of mentions rather than of a direct message.
          await postToRoom({ baseUrl: ctx.baseUrl, roomId: room.roomId, text: says });
          const frames = await stream.settle({
            settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
            quietMs: CREDENTIALED_QUIET_MS,
          });
          return { frames, room };
        } finally {
          stream.close();
        }
      }),
    oracles: [
      roomTurnRanFor('ada', 'the direct message reached the agent'),
      agentPostedInRoom('ada', {
        label: 'it answered — in a direct message there is nobody else it could have been for',
      }),
      roomNoticeCount(
        'agent_declined',
        0,
        'and the room never had to say it read this and did not reply'
      ),
    ],
  };
}

/**
 * `rooms-dm-answers-a-direct-question` — the floor, and the least ambiguous
 * shape there is.
 *
 * Graduation criterion 2 is written against this case specifically: **100%
 * across three seeds and all three runtimes**. A question mark, one subject, no
 * pleasantries to hide behind.
 *
 * Drill: the DM recipe in this module's doc. **Run live.**
 */
export const roomsDmAnswersDirectQuestionCase: EvalCase = dmAnswerRateCase(
  'rooms-dm-answers-a-direct-question',
  'Rooms DM — a direct question in a direct message is always answered'
);

/**
 * `rooms-dm-answers-an-ambiguous-request` — a request whose shape is not a
 * question, and which a model could plausibly read as an instruction to go away
 * and work rather than to reply.
 *
 * The interesting seed of the three: silence here is defensible reasoning
 * ("they asked me to do something, so I will do it") and still wrong, because
 * the person is left unsure the message landed. E1 is about the OBLIGATION, not
 * about whether an answer was strictly informative.
 *
 * Drill: the DM recipe in this module's doc.
 */
export const roomsDmAnswersAmbiguousRequestCase: EvalCase = dmAnswerRateCase(
  'rooms-dm-answers-an-ambiguous-request',
  'Rooms DM — an ambiguous request still gets an answer, not silent work'
);

/**
 * `rooms-dm-answers-an-implied-question` — a bare statement that implies one.
 *
 * The hardest of the three, and the one closest to how people actually write in
 * a DM. Nothing here is grammatically a question; a model reading only the form
 * has every excuse to say nothing.
 *
 * Drill: the DM recipe in this module's doc.
 */
export const roomsDmAnswersImpliedQuestionCase: EvalCase = dmAnswerRateCase(
  'rooms-dm-answers-an-implied-question',
  'Rooms DM — a statement that implies a question is answered too'
);

/**
 * `rooms-dm-restraint-on-a-bare-thanks` — **the discriminator, and without it
 * the three cases above are a check that cannot fail.**
 *
 * An agent that answers absolutely everything scores 100% on answer-rate. So the
 * suite has to contain one DM message that does NOT deserve a message back, or
 * its green is compatible with the worst behaviour the flip is supposed to make
 * possible to avoid.
 *
 * **A reaction and silence are both passes; only a MESSAGE fails.** In a DM
 * `directlyAsked` is true of every message a person sends, so an agent that
 * correctly says nothing causes the room to write its `agent_declined` line —
 * which is the room being visible on the agent's behalf, not a failure. An
 * earlier version asserted that line away and would have failed the case for
 * the best available behaviour (orchestrator ruling, 2026-08-29).
 *
 * **A reaction is a pass here, and that is the point rather than a loophole.**
 * `meta/agent-etiquette.md` E11 forbids standalone acknowledgments and E16b's
 * sending half exists to replace them; the flip is what finally makes "✅ and
 * nothing else" reachable in a DM at all. So the oracle is "no MESSAGE", not "no
 * activity" — and `agent_declined` must not fire either, because a reaction
 * discharges the obligation.
 *
 * **Its OPENER carries the unanswerable-question defect, and that is the first
 * thing to fix here (DOR-1643).** "did the importer fix go out in yesterday's
 * release?" is not answerable from the message by a fresh sandbox agent, so a
 * turn that correctly says nothing trips `openerLanded` and the case reds before
 * restraint has been measured at all — observed live on 2026-09-02. It is the
 * same defect {@link dmAnswerRateCase} records against two other cases, and it
 * is why this case's numbers are noisier than the answer-rate ones: 3 passes, 2
 * fails and one harness timeout across the DOR-1643 iteration, with at least one
 * of the fails owed to the opener rather than to a pleasantry. Give the opener
 * its own facts, exactly as the three seeds above carry theirs.
 *
 * Drill: seed `apps/server/src/services/runtimes/shared/room-tools-context.ts`
 * by deleting the "When nobody asked you, silence costs nothing" paragraph from
 * `buildToolOnlyBlock`, and re-run. STRUCTURAL: the turn runs either way.
 * VARIABLE: whether the model posts a courtesy reply without the permission to
 * stay quiet. **Specified, not yet run live** — and worth pairing with the
 * closing directive's quiet branch, which is where the quoted prohibition on
 * "Anytime" / "you're welcome" now lives.
 */
export const roomsDmRestraintOnThanksCase: EvalCase = {
  id: 'rooms-dm-restraint-on-a-bare-thanks',
  title: 'Rooms DM — "thanks!" needs no message back, and does not get one',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'dm-restraint',
        title: 'dm-restraint',
        agents: [ADA],
        kind: 'dm',
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        // The exchange is set up first, so "thanks" is a REAL closing rather
        // than an opening nobody can interpret. Without the answer above it, a
        // model has to guess what it is being thanked for, and silence would be
        // confusion rather than restraint.
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: 'did the importer fix go out in yesterday’s release?',
        });
        await stream.settle({
          settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
          quietMs: CREDENTIALED_QUIET_MS,
        });
        const opener = observedEntries(stream.frames()).find(
          (e) => e.authorId === room.agents.ada && e.kind === 'post'
        );
        // Restraint is judged from here on: the answer above is correct and
        // must not read as a failure of it.
        room.notes.windowOpenedBy = opener?.id ?? '';

        await postToRoom({ baseUrl: ctx.baseUrl, roomId: room.roomId, text: 'thanks!' });
        // No `settleWhen`: the pass shape is that nothing more arrives, so
        // waiting for a post would either hang out the drive on a correct run or
        // bias collection toward the failure being checked for.
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    openerLanded('the agent answered the question that came first'),
    agentStayedQuietInRoom('ada', {
      afterNote: 'windowOpenedBy',
      label: 'and posted no further MESSAGE in reply to a bare "thanks"',
    }),
    // **No `agent_declined: 0` oracle here, and its absence is the ruling.**
    // In a DM `directlyAsked` is true of every message a person sends, so an
    // agent that correctly says nothing to "thanks" causes the room to write
    // its one line — and asserting that line away would fail the case for the
    // best available behaviour. The three honest endings are a reaction,
    // silence, and silence-with-the-room's-line; only a MESSAGE is
    // over-participation, and that is what the oracle above catches.
  ],
};

/**
 * `rooms-channel-mentioned-question-posts` — the channel floor.
 *
 * The mirror of the DM cases in the room kind where silence IS often right: a
 * person named the agent and asked it something, so the obligation is the same
 * one E1 states and the flip must not have made answering harder.
 *
 * **The question carries its own facts, for the same reason the DM seeds do.**
 * The first version asked "which rows is the importer dropping, and why?" of a
 * fresh sandbox agent that had no way to know — and on 2026-08-29 it failed live
 * exactly as an unanswerable question fails: the agent called
 * `search_room_history` and `read_room_history`, found nothing, and released
 * `outcome: 'silent'`. That red conflates knowledge with obligation and says
 * nothing about the channel floor. So the message now states what happened and
 * asks for a judgement on it, and the only reason left to stay silent is failing
 * the obligation.
 *
 * **Run live, and PASSED once with the self-contained question** — run 7 in this
 * module's findings table, `2026-08-29T09-00-18-112Z`. One green is not the bar,
 * which is three, so this stays quarantined. Runs 4 and 6 are the same case
 * asking the unanswerable version and are discounted rather than counted.
 *
 * Drill: strip the "When somebody ASKED you … answering is not optional"
 * paragraph from `buildToolOnlyBlock` and re-run. **Specified, not yet run
 * live** — and now worth paying for, because a case that passes is one whose
 * green a mutation can actually falsify.
 */
export const roomsChannelMentionedQuestionPostsCase: EvalCase = {
  id: 'rooms-channel-mentioned-question-posts',
  title: 'Rooms — mentioned with a real question in a channel, the agent posts an answer',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'channel-asked',
        title: 'channel-asked',
        agents: [ADA],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} last night's importer log rejected 12 rows: 9 of them ` +
            'failed on a semicolon in the address field and 3 on an empty postcode. Which of ' +
            'those two should we fix first?',
        });
        const frames = await stream.settle({
          settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
          quietMs: CREDENTIALED_QUIET_MS,
        });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    roomTurnRanFor('ada', 'the mention triggered a turn'),
    agentPostedInRoom('ada', { label: 'the agent answered the question it was asked' }),
    roomNoticeCount('agent_declined', 0, 'so no "did not reply" line was owed'),
  ],
};

/**
 * `rooms-channel-yields-when-a-human-answered` — A-08, reachable for the first
 * time.
 *
 * **Standing down had no representation before the flip.** A turn that ran
 * always spoke, so an agent watching a person already answer could only add to
 * the pile; `meta/chat-capabilities.md` A-08 has read `not built` since the file
 * existed. An unmade tool call is what makes yielding expressible, and this is
 * the case that measures whether a model actually does it.
 *
 * The shape is deliberately generous to the agent: it is `engaged`, so it is
 * triggered by the follow-up but was not named by it, and a colleague has
 * already given a complete answer. Posting anything is duplication.
 *
 * **Specified, not yet run live**, and the honest expectation is that this is
 * the hardest case in the file — nothing instructs an agent to yield, which is
 * the point. A red here is a finding about conduct rather than about the
 * mechanism, and is what a `DOR-1203`-shaped should-respond gate would answer.
 */
export const roomsChannelYieldsToHumanCase: EvalCase = {
  id: 'rooms-channel-yields-when-a-human-answered',
  title: 'Rooms A-08 — a person already answered, so the agent stands down',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA_ENGAGED]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'yield',
        title: 'yield',
        agents: [ADA_ENGAGED],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        // The window has to be OPENED, or an `engaged` agent is not triggered at
        // all and a green would prove nothing — the same setup the restraint
        // case in `rooms-recall.ts` argues for at length.
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: `${mentionOf(room, 'ada')} morning — anything from you on the importer today?`,
        });
        await stream.settle({
          settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
          quietMs: CREDENTIALED_QUIET_MS,
        });
        const opener = observedEntries(stream.frames()).find(
          (e) => e.authorId === room.agents.ada && e.kind === 'post'
        );
        room.notes.windowOpenedBy = opener?.id ?? '';

        // A question the agent is NOT named in, immediately and completely
        // answered by somebody else. One human, two voices — this install
        // resolves every un-headered caller to its owner, so the speakers are
        // named inside the text (the restraint case makes the same concession).
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: 'Kai: does anyone know which branch the importer fix landed on?',
        });
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: 'Priya: it went out on release/2026-08-27 — I merged it myself yesterday afternoon.',
        });
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    openerLanded('the agent answered when it WAS addressed'),
    agentStayedQuietInRoom('ada', {
      afterNote: 'windowOpenedBy',
      label: 'and added nothing to a question a colleague had already answered',
    }),
    roomNoticeCount('agent_declined', 0, 'nobody asked IT, so the room said nothing about it'),
  ],
};

/**
 * `rooms-ack-only-reacts-under-the-flip` — A-06, closed by mechanism rather than
 * by prompt.
 *
 * **The headline case of the whole feature.** `meta/chat-capabilities.md` A-06
 * recorded the measured failure — "having reacted, the agent still wrote 'Done —
 * release notes acknowledged.', and a room turn's text is posted" — and
 * concluded it was model-tuning territory. It was a mechanism gap: three rounds
 * of prompt fixes could not close it because the sentence they argued against
 * was TRUE. Under the flip the narration is not posted at all.
 *
 * Deliberately a SECOND case rather than an edit to
 * `rooms-ack-only-reacts-not-replies`. That one measures the model under the
 * shipped default and is graduation criterion 4 — it goes green when PR4 flips
 * the default, and editing it now would destroy the before/after pair that makes
 * the graduation argument.
 *
 * **Specified, not yet run live.**
 */
export const roomsAckOnlyReactsUnderFlipCase: EvalCase = {
  id: 'rooms-ack-only-reacts-under-the-flip',
  title: 'Rooms A-06 — with the flip on, an acknowledgment is a reaction and nothing else',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'ack-flip',
        title: 'ack-flip',
        agents: [ADA],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        const posted = await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} the release notes are proofread and merged. ` +
            'No reply needed, just ack this.',
        });
        room.notes.ackEntryId = posted.entryId;
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    roomTurnRanFor('ada', 'the mention triggered a turn'),
    agentReactedInRoom('ada', {
      entryIdNote: 'ackEntryId',
      label: 'the agent left a reaction on the message that asked only for one',
    }),
    agentStayedQuietInRoom('ada', {
      label: 'and posted no text — under the flip its narration cannot leak into the room',
    }),
  ],
};

/**
 * `rooms-dm-reaction-can-be-the-whole-answer` — the DM half of A-06, which the
 * §2.6 reversal made reachable at all.
 *
 * Before DOR-1613 an agent in a direct message could not say "seen 👍" and stop:
 * `post_to_room` refused DMs and the turn's text posted whatever it thought. So
 * this case could not have existed, and its existence is part of what the
 * reversal bought.
 *
 * **Specified, not yet run live.**
 */
export const roomsDmReactionIsTheAnswerCase: EvalCase = {
  id: 'rooms-dm-reaction-can-be-the-whole-answer',
  title: 'Rooms DM — an acknowledgment in a direct message can be a reaction alone',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'dm-ack',
        title: 'dm-ack',
        agents: [ADA],
        kind: 'dm',
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        const posted = await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: 'heads up — I moved the importer notes into the shared drive. Just ack, no reply needed.',
        });
        room.notes.ackEntryId = posted.entryId;
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    roomTurnRanFor('ada', 'the direct message reached the agent'),
    agentReactedInRoom('ada', {
      entryIdNote: 'ackEntryId',
      label: 'it acknowledged with a reaction, which a DM could not carry before the reversal',
    }),
    roomNoticeCount(
      'agent_declined',
      0,
      'a reaction discharges the obligation, so no line was owed'
    ),
  ],
};

/** A phrase no answer to this question should need, and every leak would carry. */
const REASONING_MARKER = 'let me think through';

/**
 * `rooms-thinking-stays-in-the-session` — the flip's second promise, measured.
 *
 * "Its reasoning stays in its own session" is half of what the feature is FOR,
 * and the mechanism guarantees only that the turn's narration is not auto-posted
 * — it cannot stop a model from pasting its own working into a tool call. So the
 * question this asks is about conduct: given a question that invites visible
 * deliberation, does the agent post one considered message or its scratchpad?
 *
 * The oracle is deliberately weak and says so: it asserts a SHORT answer and no
 * step-by-step marker, which is a proxy. A strong version would need a judge
 * model, which this suite does not have and which would cost more than the
 * signal is worth today.
 *
 * **Specified, not yet run live.** Known defect carried deliberately: the
 * question is not self-contained (see the defect note on
 * {@link dmAnswerRateCase}); fix it with the run that first reads a red here.
 */
export const roomsThinkingStaysPrivateCase: EvalCase = {
  id: 'rooms-thinking-stays-in-the-session',
  title: 'Rooms — the room gets the answer, not the working out',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'private-thinking',
        title: 'private-thinking',
        agents: [ADA],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} we have three importer bugs open and one afternoon. ` +
            'Which one should we take first?',
        });
        // **No `settleWhen`, and that is the assertion's precondition.**
        // Settling on the first post truncates collection there, which makes the
        // shape this case exists to catch — a second and third bubble, or a
        // scratchpad dump after the answer — structurally uncollectable. The
        // pass shape is "one post and then nothing", so the wait has to be for
        // quiet, exactly as the ack and decline cases do it.
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    agentPostedInRoom('ada', { label: 'it answered the question' }),
    noRoomEntryContains(
      REASONING_MARKER,
      'and the room got a recommendation rather than the deliberation behind it'
    ),
  ],
};

/**
 * `rooms-answers-three-questions-in-one-message` — E8 as measured conduct, now
 * that the ceiling behind it is a mechanism.
 *
 * `rooms.maxPostsPerTurn` refuses a fourth post; it does not make three a good
 * idea. What a colleague does with three questions in one breath is answer them
 * once, and this is the only case that measures whether a model does.
 *
 * The oracle counts POSTS rather than judging prose, which is the honest thing
 * an oracle can do here: one entry that addresses all three is indistinguishable
 * from one that addresses one, without a judge. What it does catch is the shape
 * the ceiling was built for — a serialised answer arriving as three bubbles.
 *
 * **Specified, not yet run live.** Known defect carried deliberately: the
 * question is not self-contained (see the defect note on
 * {@link dmAnswerRateCase}); fix it with the run that first reads a red here.
 */
export const roomsAnswersInOneMessageCase: EvalCase = {
  id: 'rooms-answers-three-questions-in-one-message',
  title: 'Rooms E8 — three questions in one breath get one considered answer',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'one-message',
        title: 'one-message',
        agents: [ADA],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} three things: is the importer green, ` +
            'did the CSV fix ship, and who is on call this weekend?',
        });
        // **No `settleWhen`, and that is the assertion's precondition.**
        // Settling on the first post truncates collection there, which makes the
        // shape this case exists to catch — a second and third bubble, or a
        // scratchpad dump after the answer — structurally uncollectable. The
        // pass shape is "one post and then nothing", so the wait has to be for
        // quiet, exactly as the ack and decline cases do it.
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    agentPostedInRoom('ada', { label: 'the agent answered' }),
    agentPostCount('ada', 1, 'and said it in ONE message rather than three'),
  ],
};

/**
 * `rooms-ambient-silence-is-free-for-a-model-too` — the credentialed twin of the
 * structural ambient case.
 *
 * `rooms-ambient-silence-writes-nothing` proves the ROOM writes nothing when a
 * scripted turn says nothing. It cannot prove a model would choose to say
 * nothing, which is the behaviour the whole flip is for: E7 makes silence free,
 * and over-participation is the failure mode users complain about.
 *
 * **Its opener is a real QUESTION, not a "thanks", and that matters.** An
 * opener that thanked the agent would demand a reply to a pleasantry in a
 * CHANNEL — contradicting `buildToolOnlyBlock`'s own "when nobody asked you,
 * silence costs nothing" and failing the case for obeying it. A question is
 * unambiguously owed an answer, which is what opens the engaged window without
 * asking the model to do the wrong thing to get there.
 *
 * **Distinct from `rooms-restraint-ambient-chatter` in `rooms-recall.ts`**, which
 * is otherwise its near-twin. That one runs with the flip OFF and measures
 * whether the model's own judgment keeps it quiet when its text would post
 * anyway; this one runs with the flip ON and measures whether it declines to
 * reach for the tool. They are the before and after of the same question, and
 * PR4's graduation argument needs both.
 *
 * **Specified, not yet run live.** Its drill is the same seed as the DM
 * restraint case — remove the permission to stay quiet from `buildToolOnlyBlock`
 * — and its red is a post appearing where none was owed.
 */
export const roomsAmbientSilenceIsFreeCase: EvalCase = {
  id: 'rooms-ambient-silence-is-free-for-a-model-too',
  title: 'Rooms E7 — overhearing a conversation it has nothing to add to, the agent stays out',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA_ENGAGED]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'ambient-free',
        title: 'ambient-free',
        agents: [ADA_ENGAGED],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} the importer dropped 12 rows with semicolons in ` +
            'the address field last night. Worth blocking the release for?',
        });
        await stream.settle({
          settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
          quietMs: CREDENTIALED_QUIET_MS,
        });
        const opener = observedEntries(stream.frames()).find(
          (e) => e.authorId === room.agents.ada && e.kind === 'post'
        );
        room.notes.windowOpenedBy = opener?.id ?? '';

        for (const line of [
          'Kai: is the offsite still the 14th?',
          'Priya: yes, and I booked the room with the whiteboard.',
          'Kai: perfect, I will bring the retro notes.',
        ]) {
          await postToRoom({ baseUrl: ctx.baseUrl, roomId: room.roomId, text: line });
        }
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    openerLanded('the agent answered when it WAS addressed'),
    agentStayedQuietInRoom('ada', {
      afterNote: 'windowOpenedBy',
      label: 'and stayed out of a conversation about the offsite',
    }),
    roomNoticeCount('agent_declined', 0, 'nobody asked, so silence cost nothing and said nothing'),
  ],
};

/**
 * `rooms-declines-visibly-rather-than-vanishing` — E21, and the case that says
 * what "good" looks like above the floor.
 *
 * The `agent_declined` notice is a MECHANISM and a floor: it guarantees a person
 * who asked is never left guessing. What it is not is the goal — E21 says
 * decline like a colleague, with a brief reason. So this asks something the
 * agent genuinely cannot know and passes on EITHER honest outcome: it posts a
 * short "I do not know", or it says nothing and the room writes exactly one
 * line. What it fails on is the third outcome — nothing at all — and on
 * confabulation.
 *
 * **This is the only case in the file whose oracle is a disjunction**, and that
 * is deliberate rather than lax: both outcomes discharge E1, and forcing one
 * would be encoding a preference the etiquette standard does not state.
 *
 * **Specified, not yet run live.**
 */
export const roomsDeclinesVisiblyCase: EvalCase = {
  id: 'rooms-declines-visibly-rather-than-vanishing',
  title: 'Rooms E21 — asked something unknowable, the agent says so or the room does',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> =>
    underTheFlip(ctx.baseUrl, async () => {
      const { room, stream } = await openRoomFor(ctx, {
        slug: 'visible-decline',
        title: 'visible-decline',
        agents: [ADA],
        timeoutMs: CREDENTIALED_TIMEOUT_MS,
      });
      try {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text:
            `${mentionOf(room, 'ada')} what did Priya say about the importer in the ` +
            'standup this morning?',
        });
        const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
        return { frames, room };
      } finally {
        stream.close();
      }
    }),
  oracles: [
    roomTurnRanFor('ada', 'the mention triggered a turn'),
    somethingVisibleLanded(
      'ada',
      'the person who asked was left with SOMETHING — an answer, or the room saying there was not one'
    ),
  ],
};

/** Every judgment rooms case, in registration order. */
export const roomsJudgmentCases: EvalCase[] = [
  roomsDmAnswersDirectQuestionCase,
  roomsDmAnswersAmbiguousRequestCase,
  roomsDmAnswersImpliedQuestionCase,
  roomsDmRestraintOnThanksCase,
  roomsChannelMentionedQuestionPostsCase,
  roomsChannelYieldsToHumanCase,
  roomsAckOnlyReactsUnderFlipCase,
  roomsDmReactionIsTheAnswerCase,
  roomsThinkingStaysPrivateCase,
  roomsAnswersInOneMessageCase,
  roomsAmbientSilenceIsFreeCase,
  roomsDeclinesVisiblyCase,
];
