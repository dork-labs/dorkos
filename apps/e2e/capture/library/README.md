# Capture media library

Raw, untouched source material for the product-capture pipeline — the
"editor's source bins," kept strictly separate from the processed deliverables
in `apps/site/public/product/`. Everything here except this README is
**gitignored**: raws are heavy and fully regenerable.

## Layout

```
library/
├── README.md              # this file (the only committed entry)
├── latest -> <run-id>     # symlink to the newest run
└── <run-id>/              # e.g. 20260706-203000 (record-time timestamp)
    ├── run.json           # provenance: settings, app git SHA, source hashes,
    │                      #   per-asset trim markers
    └── raw/
        ├── <surface>-<theme>.png   # raw screenshots, unoptimized
        └── <surface>-dark.webm     # raw Playwright recordings, unedited
```

## Phases

- `pnpm --filter @dorkos/e2e capture:record` — boots the app, drives the
  scenarios, and lands a new run here. No editing.
- `pnpm --filter @dorkos/e2e capture:process [run-id]` — edits the raws (trim
  via `run.json` markers, end-seam crossfade, two-pass VP9, poster extraction)
  into `apps/site/public/product/`. Defaults to `latest`. Never mutates raws.
- `pnpm --filter @dorkos/e2e capture` — both, in order.

The split is the payoff: an editing change (trim, seam, encode settings) is
re-process-only — no app boot, no re-recording.

## Retention

The last 3 runs are kept; older runs are pruned automatically at the end of
each record run (reported in the run output). The published `manifest.json`
carries a `runId` field tying the live assets back to their source run.
