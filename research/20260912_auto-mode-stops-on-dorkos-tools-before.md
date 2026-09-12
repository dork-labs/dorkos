# Auto-mode stops on DorkOS tools: the BEFORE reading

**Date:** 2026-09-12
**For:** spec `auto-mode-classifier-context` — "Telling auto mode what it cannot see"
**Script:** `scratchpad/classifier/count-dorkos-permission-stops.py` (scratch; reproduce with the method below)

## Why a number was taken before the change

The host-context note is a claim that auto mode will stop the agent less often on
DorkOS's own tools. A claim like that decays into a feeling within a week unless
somebody writes the starting figure down, so the counter shipped with the feature
(`GET /api/debug/auto-mode-stops`) and this is the reading that precedes it.

## Method

Walk every `*.jsonl` transcript under a Claude Code projects root. For each
`tool_use` block whose name starts with `mcp__dorkos__`, find the matching
`tool_result` and test its text against the phrases the runtime writes when a
call stopped for a person and did not get a yes ("requested permissions to use",
"the user doesn't want to proceed", "tool use was rejected", and so on).

Two figures come out, and **only the second is comparable with the runtime
counter**:

- `stops` — every detected stop, in any permission mode.
- `stopsInAutoSessions` — stops whose session the transcript also shows in
  `auto`. The counter is auto-only, because every other mode asks about
  everything by design, so a total that folds in default-mode denials is a
  different population.

The first version of this script reported only `stops`. That was the wrong
population and review caught it; the correction is the whole reason this note
exists rather than a line in a PR body.

## Result

| Projects root | Files | `mcp__dorkos__*` calls | `stops` | `stopsInAutoSessions` | Sessions seen in auto |
| ------------- | ----- | ---------------------- | ------- | --------------------- | --------------------- |
| `~/.claude`   | 942   | 410                    | 1       | 0                     | 2                     |
| `~/.claude2`  | 1362  | 94                     | 0       | 0                     | 1                     |
| `~/.claude3`  | 1313  | 76                     | 2       | 0                     | 4                     |
| **Total**     | 3617  | 580                    | **3**   | **0**                 | 7                     |

All three stops are on `mcp__dorkos__relay_send_and_wait`, and all three carry
the same text: _"the user doesn't want to proceed with this tool use"_. That is a
person reading a card and pressing no.

## What this says, and what it does not

**The BEFORE reading for the thing being changed is zero.** Not "small" — zero.
No stop in the local history happened in an auto-mode session, so nothing in
these 3,617 files is a stop the note could have removed.

Three things follow, and they matter more than the number:

1. **The three stops that exist are the kind this feature must NOT remove.** They
   are user denials in a mode that was supposed to ask. If a future reading shows
   them gone, that is a regression, not a win.
2. **The measurement has to come from the runtime counter, not from transcripts.**
   Auto mode has barely been used on this machine (7 sessions ever), and a
   transcript can only ever record stops that ended badly — an approved ask
   leaves the tool result of an ordinary successful call behind. The counter
   records the ask itself, at the moment the card is raised.
3. **The comparison needs auto mode to actually be used.** The honest next step is
   a dogfood window with `DORKOS_CLASSIFIER_CONTEXT` on and a second with it off,
   reading `stops` per DorkOS tool call off the endpoint each time. Until then
   there is a mechanism and a starting figure, not a result.

## Reproducing

```bash
python3 count-dorkos-permission-stops.py ~/.claude/projects
```

Pass a different projects root to read another account home. DorkOS launches
claude-code with a per-account `CLAUDE_CONFIG_DIR`, so a machine that has used
more than one account has more than one root, and all of them have to be read.
