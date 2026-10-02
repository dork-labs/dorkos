# Mechanical gate observations — 2026-10-01

The injected 150 ms RTT gate failed its unchanged 600 ms p95 target. Local rendering,
retained slow-viewer backpressure, handoff, tab identity and diagnostics passed.
These fixture observations do not establish production readiness.

| Gate                  |                 Actual samples | Result | Observation                                                                                                               |
| --------------------- | -----------------------------: | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| Local input to render |                            100 | Pass   | p95 112.4 ms; maximum 126.0 ms                                                                                            |
| Injected 150 ms RTT   |                            100 | Fail   | p95 629.9 ms; range 590.6–645.1 ms                                                                                        |
| Retained slow viewer  |                100 fast inputs | Pass   | 13.660 seconds; fast p95 112.8 ms; slow queue maximum one frame / 44,458 bytes                                            |
| Handoff               |                     100 rounds | Pass   | acknowledgement p95 0.0077 ms; first human character p95 56.1 ms, maximum 509.9 ms                                        |
| Tab identity          | 12 pixel/mutation observations | Pass   | two canonical viewers, distinct popup, exact original revision 8 after seven zero-viewer mutations, explicit popup switch |
| Diagnostics           |             60 emitted entries | Pass   | limit 20; exact additional dropped count 51, accounting for 11 pre-existing entries                                       |

Handoff observed 100 already-started operations returning `aborted`, 100 queued
requests returning `rejected`, and zero old increments. It rotated real held Shift,
mouse drag and composition preedit through manager dispatch/reset. Five waits were
500 ms; the remaining waits were 40 ms. Three additional controller-disconnect reset
observations checked the first successor character and cleared drag/modifier/preedit.
An aborted operation does not mean an already-started browser effect was undone.

Negative controls detected removal of the epoch check while preserving the same
actor, removal of the queue guard, wrong Page JPEG bytes with valid target receipt
metadata, fabricated diagnostic loss, and withheld render acknowledgements. Exact
action receipts are separately validated and retained as bounded private NDJSON.

Both latency timestamps use the frontend clock: real canvas pointerdown and the
client's acknowledgement call after decode/draw/two animation frames, before its
request delay. Every counted revision matched independently decoded pixels from
the named canonical Page; response receipt identity alone cannot satisfy the gate.
The latency run occupied 22:12:52–22:14:31 UTC. The browser lane was exclusive;
host one-minute load remained approximately 3.8–4.2, so the machine was not globally idle.

Local combined capture/JPEG p95 was 31.7 ms; RTT was 28.5 ms. Local produced and
acknowledged JPEG delivery rates were about 706 kB/s. Under RTT, produced rate was
711 kB/s and acknowledged delivery 132 kB/s, with 882 dropped pending frames. The
stalled run dropped 223 frames. These are JPEG payload rates; capture and encoding
are measured together, and total wire bandwidth is not measured.

Earlier evidence remains retained: initial local 100-sample p95 130.2 ms passed;
the first RTT attempt crashed during route teardown before retaining a formal RTT
sample receipt. Its RTT count is unknown, not a pass. After bounded route cleanup,
a three-sample RTT smoke failed at p95 651.1 ms and the formal 100-sample failure
above was recorded. The live-fetch teardown regression now drains callbacks and
supports repeated cleanup without masking the primary failure.

Receipts live in separately injected private artifact directories outside tracked
source and fixture profiles. They redact executable paths and retain runtime
version, revision, SHA-256, exact subjects, sample counts and negative controls.
Native input, system clipboard, actual tunnel and accessibility parity remain
separate observations. No operator clipboard was read or written by these gates.

## Review correction checkpoint

The table and receipts above are retained pre-correction observations. Independent
review required failure-cause-specific negative controls and an additional changed
revision pixel comparison in both simultaneously subscribed viewers. The corrected
identity probe counts 15 successful pixel/mutation observations. A correctness-only
rerun after the reviewed manager lifecycle correction passed all 15, independently
checking the changed revision in both viewers. The earlier 12-observation receipt
remains retained as pre-correction evidence.

Six Node-only regressions passed for exact negative causes, changed mutation
anchors, unrelated fixture assertions, preservation of primary failures/results
through cleanup, standalone cleanup failure, and bidirectional realpath directory
separation. The real second-viewer stale-render regression passed after the reviewed
manager correction; intended same-actor epoch, queue and missing-ACK faults were
observed with cause-specific classification. Existing RTT failures remain retained
and the 600 ms target remains unchanged.

A later review found inner probe cleanup could mask the original failure before
outer cleanup saw it. Two probe-level Node regressions failed on that source and
now pass: missing-render-ACK cause survives unsubscribe failure, and a latency
assertion retains seven fixture samples while unsubscribe, transport drain and
capture restoration all run in reverse acquisition order. Cleanup failures remain
attached to the original error; standalone cleanup failures still fail the run.

The combined ACK/frame adapter records the receipt-bearing request at the same
frontend post-draw boundary, before hashing or transport. ACK-only and delayed-
timestamp mutants fail its Node regression. Native caret snapshots and pointer
metadata do not replace independent canonical Page pixel comparisons. No new
formal performance samples have been recorded after these protocol changes.

The entry point and evidence summary now live together in `mechanics/`:

```sh
node scripts/browser-control-prototype/mechanics/mechanics-gates.mjs /absolute/repository /absolute/fixture-profiles /absolute/evidence
```
