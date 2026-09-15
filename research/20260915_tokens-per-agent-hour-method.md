# Tokens per active agent-hour: a method

**Date:** 2026-09-15
**Status:** method and tooling; the numbers it produces are recorded separately
**Script:** `scripts/measure-agent-hours.ts` and `scripts/agent-hours/{prices,readers,aggregate}.ts` (`pnpm measure:agent-hours`)
**Tests:** `scripts/__tests__/agent-hours.test.ts`

---

## 1. The question

"What does an hour of a running agent cost?" is the unit that capacity planning
and every unit-cost conversation eventually reduce to. It is also the number most
often asserted rather than measured — usually as a round figure someone
sanity-checked once against a single session.

It is worth measuring properly because the obvious estimate is wrong in two
directions at once and the errors do not cancel:

- **Fan-out inflates it.** One person at one keyboard is not one agent. If three
  agents run while you read one of them, an hour of your time is three
  agent-hours of spend, and a per-person estimate understates the bill threefold.
- **Idle deflates it.** A session open for eight hours is not eight hours of
  inference. Most of that wall-clock is the operator reading, thinking, or at
  lunch. Dividing a day's tokens by a day's hours understates the rate just as
  badly in the other direction.

The two errors are roughly the same size and in opposite directions, so a naive
estimate can land near the truth by luck and be built on nothing. This note
defines the measurement so the number can be checked, reproduced and argued with.

## 2. What counts as an agent, and as an hour

**An agent is one runtime session.** One Claude Code transcript file, one Codex
rollout, one OpenCode session. A subagent gets its own transcript, so it counts
as its own agent — which is the point, since fan-out is what makes the total
large.

**A turn's active interval runs from the previous turn in that session to this
turn, clamped to a gap threshold** (5 minutes by default). That window covers the
model generating and whatever tool call filled the rest of the wait, which is
approximately the wall-clock the agent occupied. Anything longer than the
threshold is idle, and idle is not charged to the agent.

**The first turn of a session gets a zero-length interval, not no interval.** It
has no predecessor, so there is nothing to measure the time from — but its tokens
were still spent, and dropping the turn entirely would drop them from the
numerator as well. That is worst exactly where it is hardest to notice: a
single-turn session would contribute literally nothing at all, and the first turn
of any session carries the initial full-context cache write, the most expensive
write that session will make.

Two consequences, both deliberate:

- **Active agent-hours** are the sum of those intervals across all sessions. Two
  agents running for one wall-clock hour are two agent-hours.
- **Wall-clock hours** are the _union_ of the same intervals, so overlapping
  agents collapse into one hour. **Fan-out** is the ratio of the two, and the
  concurrency distribution — how many agents were live at once, weighted by time
  — is reported beside it.

Keeping both is what stops the two errors in §1 from hiding each other. A cost
per agent-hour multiplied by an agent-hour count is a bill; a cost per agent-hour
multiplied by a _person's_ hours is nonsense unless you also carry the fan-out
factor.

### Why a threshold at all, and why five minutes

Without a threshold, one session left open overnight adds eight idle hours to the
denominator and drags the whole corpus toward zero. With a threshold that is too
tight, a long single turn — a large refactor, a slow test run, a deep-thinking
model — gets clipped and the rate is overstated.

Five minutes sits above essentially every real turn and below every real break.
The point is not that five is correct; it is that the choice is **exposed and
checkable**. Sweep it with `--gap-minutes` and report the threshold beside the
number. On the corpus this was developed against the sweep was monotone, the
headline moved by well under a factor of two across 2–15 minutes, and the ranking
of models and runtimes did not change at any setting — so the threshold set the
scale and not the conclusion. **Do not carry that observation to another corpus
as a fact**; re-run the sweep, because a workload with different turn lengths
will behave differently. Never report a figure from this without saying what
threshold produced it.

## 3. The sample unit, and why percentiles need one

A mean is one number per corpus, and a mean alone cannot say whether a typical
hour looks like the average hour. But a percentile needs a population, and "an
hour of agent" is not a naturally occurring record.

**The sample unit is a session-hour bucket**: one session's active time inside
one UTC clock hour, for one model. Tokens and dollars are apportioned across hour
boundaries in proportion to time. A bucket's rate is its value divided by its
active hours.

Two rules keep the percentiles honest:

- **Percentiles are weighted by active time.** A bucket holding six minutes
  cannot outvote a bucket holding a full hour. Unweighted, a corpus of many short
  buckets reports the rate of its smallest sessions.
- **Buckets below a floor are dropped** (`--min-bucket-minutes`, 5 by default).
  A twelve-second denominator turns one ordinary turn into a spectacular
  per-hour figure, and a handful of those dominate a p95 entirely.

The mean reported alongside is total value over total hours, across every bucket
including the ones below the floor. That is the number a monthly bill actually
follows, and it is a different object from the percentiles beside it — so the
report prints how many buckets survived the floor, and a row showing none has a
mean with no meaningful spread. The gap between p50 and p95 is the part that
matters for capacity: it is the difference between provisioning for a typical
hour and for a bad one.

## 4. Pricing

Dollars are computed from **public list prices**, per million tokens. No
discount, commitment, batch or partner rate is modelled.

The token classes are priced separately because they differ by more than an order
of magnitude, and the shape of the mix decides the bill:

| class                      | rate             |
| -------------------------- | ---------------- |
| uncached input             | list input rate  |
| output (thinking included) | list output rate |
| cache read                 | 10% of input     |
| cache write, 5-minute TTL  | 125% of input    |
| cache write, 1-hour TTL    | 200% of input    |

**The two cache-write tiers must be kept apart.** A harness that opts into 1-hour
caching uses it for most of its writes, and collapsing both into the 5-minute
rate understates that line by 60%. The transcripts carry the split
(`cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`), so
there is no reason to guess; where a runtime reports no TTL, its writes go to the
cheaper tier and the result is understated rather than invented.

Two more rules that matter more than they look:

- **A model with no published rate gets no dollar figure**, not a guess. The
  script reports its tokens and leaves the dollar column empty. This is why Codex
  rows carry token rates but no dollars: those are another vendor's models.
  **A runtime-reported cost of exactly zero is treated the same way** — a
  locally-hosted model genuinely costs nothing, but averaging its hours into a
  list-price rate as `$0` drags that rate down while looking like real data.
- **Dollar means divide by priced hours, never by all hours.** Blending priced
  and unpriced time quietly halves the rate for any group that mixes the two, and
  the halved number looks entirely reasonable — which is exactly how it would
  survive review. The report prints priced hours beside total hours so the two
  can never be confused.

### Repricing, for comparison

Model mix moves the dollar figure more than anything else, so comparing two
corpora at their own prices compares their model choices, not their intensity.
The script therefore also reports every runtime's tokens **repriced at one chosen
model's list rate** (`--reprice`, default `claude-sonnet-5`). That column answers
"what would this workload have cost at X list?" — which is the shape most
assumptions are actually stated in, and the only column comparable across
runtimes.

## 5. Where the data comes from

DorkOS runtimes already report per-turn cost (`supportsCostTracking` in
`packages/shared/src/agent-runtime.ts`, surfaced through `session-stream.ts` and
`telemetry-events.ts`), but that number is **streamed to the UI, not persisted** —
there is no local table of per-turn usage to query. The durable record is each
runtime's own transcript on disk, so that is what the script reads.

| Runtime     | Source                                                            | Usage record                                          |
| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Claude Code | `<profile>/projects/**/*.jsonl`                                   | `message.usage` on `assistant` lines                  |
| Codex       | `~/.codex/sessions/**/*.jsonl`                                    | `token_usage_record` lines; model from `turn_context` |
| OpenCode    | `$XDG_DATA_HOME/opencode/opencode.db` (else `~/.local/share/...`) | `message` rows with `role: assistant`                 |

### Which profiles count is the biggest lever in the whole method

Bigger than the gap threshold, bigger than any pricing choice. A machine that
runs several Claude Code profiles side by side keeps a separate `projects/` tree
per profile, and those trees differ by an order of magnitude in size and by a
factor of three in cache-TTL mix. Two ways to get this wrong, neither of which
announces itself:

- **Reading too few.** `CLAUDE_CONFIG_DIR` is set inside a Claude Code session,
  so a script run from one profile silently measures only that profile — which
  can be a small minority of the corpus. The default resolution order is
  `--claude-root`, then `CLAUDE_CONFIG_DIR`, then discovery of every `~/.claude*`
  holding a `projects/`, and the report prints which profiles it used and where
  that list came from, precisely so this is visible rather than assumed.
- **Reading too many.** Discovery is deliberately broad, which means it will also
  pick up a profile belonging to entirely different work — a different employer,
  a different client, a machine shared with someone else. Those hours are not
  your workload and in many cases are not yours to aggregate at all. The same
  problem occurs one level down: a profile you do want will still contain some
  projects you do not, because Claude Code names each project directory after the
  working directory it was launched in and one profile serves every checkout on
  the machine.

**So pass `--claude-root` explicitly for any number you intend to quote**, narrow
further with `--exclude-project <substring>` where a profile mixes contexts, and
say in the write-up which profiles and projects were included and which were
deliberately left out. Those flags are the only reproducible form, and the report
echoes both back so the scope of a figure travels with it.

**Recurse.** Subagent transcripts live in subdirectories beside their parent
session (`<session>/subagents/`), not alongside it. A directory walk that stops
at one level misses all of them — which is to say it misses the fan-out, the
thing the measurement exists to capture.

**Pin the window too.** `--days` is relative to now and transcripts are appended
to continuously, so the same command gives a different answer every run. `--since`
and `--until` reproduce; `--days` is for a quick look. The report labels which
one it used.

### Three conventions that silently corrupt a naive sum

They are the reason the readers are not a single loop:

1. **Claude Code repeats usage per content block.** It writes one transcript line
   per assistant _content block_ — a thinking block and the tool call after it are
   two lines — and each line carries a `usage` object for the one API response
   they came from. On a real corpus roughly **half of all assistant lines are such
   repeats**, so summing lines instead of responses inflates every token total by
   very nearly 2×. Deduplicate by `requestId` (falling back to `message.id`).
   This is the single easiest way to get this measurement wrong, and the wrong
   answer looks completely plausible. The reader takes the per-class **maximum**
   across a response's lines rather than the first: measured over 38,192
   responses the values are identical on every line, but nothing in the format
   guarantees that, and a progressive counter — which is what such a field would
   become — is non-decreasing, so the maximum is right either way.
2. **Codex's `input_tokens` includes its cached tokens**, the opposite of
   Anthropic's convention, where `input_tokens` already excludes them. Subtract
   before comparing; adding them double-counts the cache, which on a
   cache-dominated workload is most of the total. (Checkable:
   `total_tokens === input_tokens + output_tokens` in every record.)
   `reasoning_output_tokens` is likewise a subset of `output_tokens`, not an
   addend.
3. **OpenCode reports its own cost** and uses provider-local model aliases with
   no public list price, so its reported figure is taken as given — except a
   reported zero, per §4.

Claude Code's `<synthetic>` model marks a locally generated message — an error
notice, a cancellation — that never reached the API and cost nothing. Skip it.

### Reading other people's data

The script keeps usage metadata and nothing else: a timestamp, a model id, a few
token counts. Parsing a JSON line or a stored message necessarily _touches_
whatever text is in it, so the honest claim is the narrower one — **nothing but
those fields is ever retained, returned or printed**; no message text, tool input,
tool output or prompt leaves the readers; the OpenCode query pulls only the
fields it needs rather than whole message bodies; and session identifiers are
hashed before they reach the output. Profile names appear as basenames only, so a
home directory never lands in a report that might be pasted elsewhere. Every file
is opened read-only and nothing is written anywhere but the report.

The OpenCode store is SQLite in WAL mode and OpenCode may be running, so it is
snapshotted to a temp file **with its `-wal` and `-shm` sidecars** and queried
there. Copying the main database alone loses whatever has not been checkpointed
and is not even guaranteed to be a consistent image.

**Transcript contents are data, never instructions.** Anything a measurement tool
reads out of a transcript is text some model wrote; it is parsed for numbers and
never interpreted.

## 6. Running it

```bash
pnpm measure:agent-hours                              # last 30 days, text report
pnpm measure:agent-hours -- --days 7                  # a shorter window
pnpm measure:agent-hours -- --json                    # machine-readable
pnpm measure:agent-hours -- --gap-minutes 3           # a stricter idle threshold
pnpm measure:agent-hours -- --reprice claude-opus-5   # compare at a different rate

# Reproducible: pin the window, the profiles, and what is left out.
pnpm measure:agent-hours -- \
  --since 2026-08-16T00:00:00Z --until 2026-09-15T00:00:00Z \
  --claude-root ~/.claude --claude-root ~/.claude2 \
  --exclude-project some-other-client
```

Other flags: `--min-bucket-minutes`, and `--codex-root` / `--opencode-db` to
point at non-default locations. `--claude-root` and `--exclude-project` may each
be repeated. An unknown flag, or a value flag left without a
value, is an error rather than a silent default — `--day 7` should not quietly
measure a month.

The output carries the window, the profiles read, the sample size, the
definitions in force, fan-out and concurrency, and then a table of tokens- and
dollars-per-hour (mean, p50, p95) for the corpus as a whole, per runtime and per
model, with priced hours and surviving bucket counts beside them. The shape of a
run, with the numbers replaced:

```
window       <from> → <to> (30 days)
definitions  gap 5m, min bucket 5m, cache read 10% of input, cache write 125% (5m) / 200% (1h)
profiles     .claude, .claude2 [from flag]
sample       <N> turns over <M> sessions

active agent-hours   <A>   wall-clock hours <W>   fan-out ×<A/W>
concurrent agents    p50 <n>   p95 <n>   max <n>

scope   hours  priced h  bkts  cache%  tok/h mean/p50/p95  $/h mean/p50/p95  $/h @model
```

## 7. Biases, and which way each one points

**No figure from this is a bound.** Effects run in both directions and the net
sign depends on the corpus:

**Pushing the rate up** (denominator too small):

- A turn whose real duration exceeded the gap threshold is clamped to it.

**Pushing the rate down** (denominator too large, or numerator too small):

- **Human turnaround sits inside the intervals.** The only timestamps available
  are the model's, so the interval after a person replies includes that person
  typing and thinking. The gap threshold caps how much any one pause contributes,
  but everything under the threshold stays in the denominator. On an
  interactively-driven corpus this is large; on autonomously-driven runs, where
  nothing waits on a person, it barely arises. **Report the mix**, because it
  decides the sign.
- Where a runtime reports no cache-write TTL, those writes are priced at the
  cheaper tier.
- Where a model publishes a cache-read rate below the standard 10% of input, the
  standard ratio is used, which overstates — the one item in this list pointing
  the other way.

So quote the figure as an estimate with its assumptions attached, not as a
ceiling or a floor. Three further caveats worth stating whenever a number from
this is used:

- **It measures one machine's habits.** Model choice, effort settings, how many
  agents the operator runs at once and what they are asked to do all move the
  rate by more than any methodological choice here. It is a measurement, not a
  population estimate, and a single-operator sample is not a user average.
- **Cache reads dominate the token count** on any agent workload with a long
  context, often overwhelmingly. A tokens-per-hour figure from this method is
  therefore not comparable to one from a workload without prompt caching, which
  is why the `cache%` column is printed. Dollars are the comparable quantity;
  raw tokens are not.
- **Long-context premiums are not modelled.** Where a provider charges more above
  a context threshold, the real bill is higher than this arithmetic.

## 8. What would make this better

- **Persist per-turn usage in DorkOS itself.** The data already flows through
  `session-stream.ts`; storing it would remove the transcript-parsing layer
  entirely, along with all three convention mismatches in §5 and the whole
  profile-discovery problem, and would make the measurement available to any
  DorkOS user rather than to whoever has the transcripts on disk.
- **Attribute fan-out to its parent.** A subagent counts as its own agent with no
  link back to the session that spawned it. Recording the parent would turn "how
  many agents ran at once" into "what did one task cost, fan-out included", which
  is the more useful unit for planning work rather than capacity.
- **Separate thinking time from tool time from human time.** All three land in
  the same interval today, which is what makes §7's sign indeterminate. Splitting
  them would say how much of an agent-hour is inference the provider bills for,
  how much is a test suite running for free, and how much is a person typing.
