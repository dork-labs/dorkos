# Browser memory with 1, 3 and 5 chats

This is the DOR-4273 measurement for B1 draft 1.2 §5.5. It supplies evidence for
the proposed six-tab window cap. It does not choose or change a cap.

**Run only in QA's sealed Linux Docker environment. Never launch this script's
browser on the Mac host.** The entry point refuses non-Linux hosts, Linux outside
Docker, and a missing graphical display before loading the browser service. Its
unit tests launch no browser.

## Prepare the image

Use the approved QA image-building path, then seal the finished image. It needs:

- This exact committed candidate as a standalone Git checkout at `/workspace`.
  Keep `.git` available for the source receipt. No source writers during the run.
- Node 24, the repo's pinned pnpm, and Linux dependencies installed with the
  frozen lockfile. Build the workspace dependencies the server imports, including
  `@dorkos/shared`, during image preparation. Never mount Mac `node_modules`.
- The repo's exact `playwright-core` version and its browser already installed,
  with the matching system libraries. The script checks the executable before
  launch and never invokes an installer. The production launch chooses installed
  Chrome if present, otherwise its pinned managed Chromium; the receipt records
  the selected executable hash and each case's actual browser version.
- Xvfb, `xvfb-run`, `timeout`, Git, and an unprivileged account that can run the
  production Chromium sandbox. Use QA's existing approved sandbox setup; do not
  substitute `--no-sandbox`, privileged Docker, or host namespaces.
- Readable `/proc/*/stat`, `/proc/*/smaps_rollup`, and cgroup v2 memory counters,
  including `memory.peak`, `memory.events`, and `memory.swap.max`. The experiment
  fails rather than substituting zero when a required metric is unavailable.

The image must contain no accounts, keys, personal profiles or agent homes.
Do not mount home directories, the Docker socket, host displays, or production
data. Image preparation may use the network for dependencies; the measuring
container cannot. Keep the image digest with the evidence.

## Run

Coordinate the heavy-job slot and check host load before starting; wait above 16.
Create an empty evidence directory owned by the image's user. Replace
`QA_IMAGE_AT_DIGEST`, `FULL_CANDIDATE_COMMIT` and `/absolute/evidence` below.
The image contains the checkout and dependencies, so the only bind mount is
the evidence directory. Do not pass the host environment through to Docker.

Chromium's sandbox needs `--cap-add SYS_ADMIN` and a non-root user (`pwuser`
in QA's image). Keep Docker's default seccomp profile, never `unconfined`.
Follow QA's `scripts/REALDATA-COPY-RULES.md`, **Chromium in Docker**, for the
sealed-test conditions. This does not permit real data or additional host mounts.

```bash
docker run --rm --init --network none --user pwuser --cap-add SYS_ADMIN --cgroupns private --ipc private --read-only --memory 4g --memory-swap 4g --cpus 2 --shm-size 1g --tmpfs /tmp:rw,exec,nosuid,size=2g --mount type=bind,src=/absolute/evidence,dst=/evidence --workdir /workspace QA_IMAGE_AT_DIGEST timeout --signal=TERM --kill-after=10s 20m xvfb-run -a pnpm exec tsx scripts/local-browser/chat-memory.ts --revision FULL_CANDIDATE_COMMIT --output /evidence/chat-memory
```

The 4 GiB limit is an explicit experiment envelope, **not an approved product
budget**. Record any changed CPU, memory, shared-memory or tmpfs limits alongside
the image digest. Keep the same envelope for every comparable run.

Default: three repeats each of 1, 3 and 5 chats, with ten samples per idle and
reading phase, one second apart. The second repeat reverses the case order.
Each case gets a fresh browser/profile and closes it before the next case.
The run normally takes several minutes. A timeout, OOM, missing case or incomplete
receipt is a failed experiment, even if earlier numbers look reasonable.

For direct evidence at the proposed boundary, repeat the command with
`--chats 1,3,5,6` and a **new** output directory. The default one-tab-per-chat
matrix and the optional six-chat case both use existing production limits.
The broker currently allows five pages per chat and 25 total; neither limit is
changed by this script. This experiment grants exactly one page to each chat.

Options are bounded: `--repeats 1..5`, `--samples 5..60`, and
`--interval-ms 200..2000`. Do not compare results collected at different settings
without labeling that difference. Output directories cannot be reused.

## What is measured

The real `LocalBrowserService`, page leases, audit and production headed-browser
launch run in-process. The script asserts one physical launch and exactly one
physical page per chat. Each page has its own HTTPS fixture origin and 100
made-up article/button rows. Playwright fulfills those requests locally; every
other page request is aborted. There is no DorkOS UI, model call, external site,
sign-in, download or screenshot in this measurement.

Before sampling, each loaded page's real ARIA snapshot must fit within 32 KiB,
one quarter of production's unchanged 128 KiB observation limit. The rendered
snapshot byte counts are saved in each case's `fixtureSnapshotBytes` receipt.
Every production `observe` in the reading phase must also stay within that
budget. The fast unit regression separately bounds the fixture's HTML size;
HTML size alone is not evidence of rendered snapshot size. Older runs with the
1,000-article fixture are not comparable; do not mix their measurements with this
fixture's results. The fixture hash identifies the actual document used.

Each case records these phases:

1. **before-browser:** five Node/container baseline samples.
2. **warm-up:** three samples after all fixture documents have loaded; retained
   separately from the steady-state summaries.
3. **idle:** loaded tabs with no agent activity.
4. **reading:** every chat calls the real service's `observe` concurrently before
   each sample. The sample timestamps include the time spent reading.
5. **after-close:** five samples after the service closes the browser and the
   process census confirms physical closure.

The browser census uses numeric PID, parent and start-time identities, never
process command lines or environments. A reused root PID invalidates evidence.
Browser totals cover the launched roots and their living descendants. Detached
helpers outside that tree remain included in the container total. A process
vanishing during a sample is counted explicitly rather than silently treated
as zero; prefer samples without such gaps when reviewing browser totals.

| Metric                       | Meaning                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `browserPssBytes`            | Browser proportional resident memory; shared mappings are apportioned.           |
| `browserPrivateBytes`        | Browser private clean and dirty mappings.                                        |
| `browserRssBytes`            | Sum of browser RSS; shared pages can be counted several times.                   |
| `nodeRssBytes`               | The service/driver Node process, reported separately.                            |
| `containerBytes`             | Entire experiment cgroup, including Node, browser, Xvfb, helpers and file cache. |
| `containerPeakLifetimeBytes` | Cgroup peak since container start; **not** a per-case peak.                      |
| `oomKills`                   | Cgroup OOM counter; an increment fails the experiment.                           |

All byte values are raw bytes. Divide by 1,048,576 for MiB. These are overlapping
views: do not add RSS, PSS and container memory together. Per-phase summaries keep
minimum, nearest-rank median, p95 and maximum, with every raw sample preserved.

## Read and report

Keep `memory.json`, every `case-*.json`, every source snapshot, container exit
status/log and image digest together. Each completed case has `status: measured`
and `cleanup: closed`. The final report must also say `status: measured`, contain
all nine cases (twelve with six chats), match the candidate commit, and have
unchanged source snapshots. A partial case is written after each completed phase
so a failure still leaves evidence. `capDecision` intentionally stays `pending`.

Report a table with one row per chat count and phase: browser PSS median/p95/max,
Node RSS p95, container memory median/p95/max, and container change from that
case's before-browser baseline. Include after-close values and OOM/cleanup
results. Show variation across repeats; do not hide the largest repeat in an
average. Preserve negative baseline deltas as observed, rather than clipping them.

Send the coordinator the exact source range, image digest, runtime/architecture,
limits, fixture and numbers. PM decides whether those numbers fit the intended
computer budget. A 1/3/5 run does not measure six chats; label any extrapolation,
or use the optional six-chat run. These synthetic documents cannot establish
memory bounds for arbitrary websites, long-lived sessions, video, downloads or
the whole DorkOS app. This is also **not** Security's popup/focus proof.

No numbers were produced on the Mac while writing this harness. The six-tab
decision remains pending the checker's Docker run and PM's review.
