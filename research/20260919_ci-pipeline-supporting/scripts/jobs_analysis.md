Runs with job data: 1872 (S1 stratified 270, S2 merge_group failures 585, S3 full-day 2026-09-15 census 1053)

#### Job timings, stratified sample (30d sample)

| workflow           | event        | runs | job                 | n   | dur med | dur p90 | queue-wait med | queue-wait p90 | queue-wait max |
| ------------------ | ------------ | ---- | ------------------- | --- | ------- | ------- | -------------- | -------------- | -------------- |
| browser-test       | merge_group  | 30   | browser-shard (3/3) | 30  | 21.9m   | 28.4m   | 2s             | 2s             | 53s            |
| browser-test       | merge_group  | 30   | browser-shard (2/3) | 30  | 20.2m   | 22.8m   | 2s             | 3s             | 14.3m          |
| browser-test       | merge_group  | 30   | browser-shard (1/3) | 30  | 18.5m   | 21.7m   | 2s             | 3s             | 11.1m          |
| browser-test       | merge_group  | 30   | copy-spec-drift     | 16  | 44s     | 52s     | 2s             | 3s             | 25s            |
| browser-test       | merge_group  | 30   | browser-test        | 30  | 14s     | 16s     | 2s             | 4s             | 10.5m          |
| browser-test       | pull_request | 30   | browser-shard (3/3) | 4   | 20.4m   | 20.8m   | 4s             | 26s            | 35s            |
| browser-test       | pull_request | 30   | browser-shard (2/3) | 4   | 18.4m   | 18.8m   | 2s             | 24s            | 33s            |
| browser-test       | pull_request | 30   | browser-shard (1/3) | 4   | 15.6m   | 16.0m   | 2s             | 3s             | 3s             |
| browser-test       | pull_request | 30   | copy-spec-drift     | 17  | 46s     | 56s     | 2s             | 3s             | 10s            |
| browser-test       | pull_request | 30   | browser-test        | 30  | 4s      | 7s      | 2s             | 4s             | 1.2m           |
| claude-code-review | pull_request | 30   | review              | 30  | 3.6m    | 6.3m    | 2s             | 5s             | 12.9m          |
| lint               | merge_group  | 30   | lint                | 30  | 6.3m    | 7.1m    | 2s             | 3s             | 38s            |
| lint               | pull_request | 30   | lint                | 30  | 6.0m    | 6.8m    | 2s             | 3s             | 3s             |
| test               | merge_group  | 30   | test-shard          | 88  | 12.8m   | 16.0m   | 2s             | 10s            | 6.3m           |
| test               | merge_group  | 30   | community-packaged  | 2   | 6.2m    | 6.4m    | 2s             | 2s             | 2s             |
| test               | merge_group  | 30   | community-pg        | 2   | 2.1m    | 2.1m    | 3s             | 4s             | 4s             |
| test               | merge_group  | 30   | test                | 30  | 16s     | 32.3m   | 2s             | 3s             | 6.0m           |
| test               | pull_request | 30   | test-shard          | 56  | 9.4m    | 15.6m   | 2s             | 3s             | 4s             |
| test               | pull_request | 30   | community-pg        | 1   | 2.4m    | 2.4m    | 2s             | 2s             | 2s             |
| test               | pull_request | 30   | test                | 30  | 40s     | 34.8m   | 2s             | 3s             | 27.2m          |
| test               | pull_request | 30   | community-packaged  | 1   | 2s      | 2s      | 2s             | 2s             | 2s             |
| typecheck          | merge_group  | 30   | typecheck           | 30  | 5.2m    | 7.6m    | 2s             | 3s             | 54s            |
| typecheck          | pull_request | 30   | typecheck           | 30  | 4.6m    | 7.9m    | 2s             | 3s             | 7.8m           |

#### Job timings, stratified sample (7d sample only)

| workflow           | event        | runs | job                 | n   | dur med | dur p90 | queue-wait med | queue-wait p90 | queue-wait max |
| ------------------ | ------------ | ---- | ------------------- | --- | ------- | ------- | -------------- | -------------- | -------------- |
| browser-test       | merge_group  | 10   | browser-shard (3/3) | 10  | 25.5m   | 29.4m   | 2s             | 2s             | 2s             |
| browser-test       | merge_group  | 10   | browser-shard (2/3) | 10  | 22.4m   | 23.2m   | 2s             | 3s             | 3s             |
| browser-test       | merge_group  | 10   | browser-shard (1/3) | 10  | 21.4m   | 22.8m   | 2s             | 3s             | 3s             |
| browser-test       | merge_group  | 10   | copy-spec-drift     | 10  | 46s     | 53s     | 2s             | 2s             | 3s             |
| browser-test       | merge_group  | 10   | browser-test        | 10  | 15s     | 16s     | 2s             | 3s             | 3s             |
| browser-test       | pull_request | 10   | copy-spec-drift     | 10  | 48s     | 57s     | 2s             | 3s             | 3s             |
| browser-test       | pull_request | 10   | browser-test        | 10  | 4s      | 4s      | 2s             | 3s             | 4s             |
| claude-code-review | pull_request | 10   | review              | 10  | 4.3m    | 6.3m    | 2s             | 4s             | 10s            |
| lint               | merge_group  | 10   | lint                | 10  | 6.9m    | 7.5m    | 2s             | 2s             | 2s             |
| lint               | pull_request | 10   | lint                | 10  | 6.3m    | 7.0m    | 2s             | 3s             | 3s             |
| test               | merge_group  | 10   | test-shard          | 40  | 15.1m   | 16.7m   | 2s             | 3s             | 43s            |
| test               | merge_group  | 10   | community-packaged  | 2   | 6.2m    | 6.4m    | 2s             | 2s             | 2s             |
| test               | merge_group  | 10   | community-pg        | 2   | 2.1m    | 2.1m    | 3s             | 4s             | 4s             |
| test               | merge_group  | 10   | test                | 10  | 12s     | 14s     | 2s             | 2s             | 3s             |
| test               | pull_request | 10   | test-shard          | 40  | 9.4m    | 16.0m   | 2s             | 3s             | 3s             |
| test               | pull_request | 10   | community-pg        | 1   | 2.4m    | 2.4m    | 2s             | 2s             | 2s             |
| test               | pull_request | 10   | test                | 10  | 4s      | 4s      | 2s             | 3s             | 4s             |
| test               | pull_request | 10   | community-packaged  | 1   | 2s      | 2s      | 2s             | 2s             | 2s             |
| typecheck          | merge_group  | 10   | typecheck           | 10  | 5.2m    | 5.8m    | 2s             | 3s             | 3s             |
| typecheck          | pull_request | 10   | typecheck           | 10  | 4.7m    | 5.0m    | 2s             | 2s             | 2s             |

#### Dominant steps (S1 sample, successful attempt-1 jobs, median minutes; top 6 steps per job)

- **browser-test / merge_group / browser-shard**: Run the browser suite 18.4m; Build what the webServer legs boot from 54s; Install the Chromium browser Playwright drives 27s; Run actions/setup-node@v4 15s; Run actions/setup-node@v7 14s; Run pnpm install --frozen-lockfile 8s
- **browser-test / pull_request / browser-shard**: Run the browser suite 16.6m; Build what the webServer legs boot from 49s; Install the Chromium browser Playwright drives 16s; Run actions/setup-node@v4 15s; Run pnpm install --frozen-lockfile 8s; Run actions/checkout@v4 7s
- **claude-code-review / pull_request / review**: Claude Code review 3.2m; Checkout 12s; Clear re-review label 2s; Set up job 1s; Count changed files 1s; Verify the review result and posted verdict 0s
- **lint / merge_group / lint**: Formatting gate — prettier --check (DOR-485) 3.4m; Lint every package 2.2m; Run actions/setup-node@v7 14s; Run pnpm install --frozen-lockfile 8s; Run actions/checkout@v7 7s; Run pnpm/action-setup@v6 4s
- **lint / pull_request / lint**: Formatting gate — prettier --check (DOR-485) 3.3m; Lint every package 2.1m; Run actions/setup-node@v7 15s; Run pnpm install --frozen-lockfile 8s; Run actions/checkout@v7 8s; Run pnpm/action-setup@v6 4s
- **test / merge_group / community-packaged**: Build and test without public network access 5.9m; Run actions/checkout@v7 8s; Preserve packaged community reports 3s; Set up job 1s; Post Run actions/checkout@v7 0s; Complete job 0s
- **test / merge_group / test**: Run every package's test suite 29.9m; Run actions/setup-node@v4 15s; Run actions/checkout@v4 13s; Run actions/setup-node@v7 10s; Run pnpm install --frozen-lockfile 8s; Run actions/checkout@v7 8s
- **test / merge_group / test-shard**: Run every package's test suite (shard 4/4) 12.3m; Run every package's test suite (shard 1/4) 12.1m; Run every package's test suite (shard 2/4) 11.7m; Run every package's test suite (shard 3/4) 11.1m; Run actions/setup-node@v7 14s; Run actions/checkout@v7 13s
- **test / pull_request / test**: Run every package's test suite 29.7m; Run the affected packages' test suites 22.1m; Run actions/setup-node@v4 15s; Run actions/setup-node@v7 12s; Run actions/checkout@v7 12s; Run actions/checkout@v4 12s
- **test / pull_request / test-shard**: Run the affected packages' test suites (shard 4/4) 10.7m; Run the affected packages' test suites (shard 2/4) 9.7m; Run the affected packages' test suites (shard 1/4) 8.9m; Run the affected packages' test suites (shard 3/4) 7.9m; Run actions/setup-node@v7 13s; Run actions/checkout@v7 13s
- **typecheck / merge_group / typecheck**: Typecheck every package that declares a typecheck script 3.6m; Formatting gate — prettier --check (DOR-485) 3.3m; Run actions/setup-node@v4 17s; Run actions/setup-node@v7 14s; Run pnpm install --frozen-lockfile 8s; Run actions/checkout@v7 8s
- **typecheck / pull_request / typecheck**: Typecheck every package that declares a typecheck script 3.5m; Formatting gate — prettier --check (DOR-485) 3.4m; Run actions/setup-node@v7 14s; Run actions/setup-node@v4 14s; Run pnpm install --frozen-lockfile 9s; Run actions/checkout@v7 8s

#### merge_group failures of test / browser-test (all, 30d): failing job and step

| workflow     | failing job         | count 30d | count 7d |
| ------------ | ------------------- | --------- | -------- |
| browser-test | browser-test        | 363       | 27       |
| test         | test                | 219       | 4        |
| browser-test | browser-shard (1/3) | 219       | 14       |
| browser-test | browser-shard (2/3) | 206       | 7        |
| browser-test | browser-shard (3/3) | 72        | 6        |
| test         | test-shard (3/4)    | 50        | 0        |
| test         | test-shard (4/4)    | 17        | 3        |
| test         | test-shard (1/4)    | 13        | 0        |
| browser-test | copy-spec-drift     | 3         | 2        |
| test         | test-shard (2/4)    | 2         | 0        |
| test         | community-packaged  | 1         | 1        |

| workflow     | failing step                                           | count 30d |
| ------------ | ------------------------------------------------------ | --------- |
| browser-test | Run the browser suite                                  | 491       |
| browser-test | Refuse a run whose shards did not all pass             | 361       |
| test         | Run every package's test suite                         | 136       |
| test         | Require all four shards green (queue leg)              | 75        |
| test         | Run every package's test suite (shard 3/4)             | 50        |
| test         | Run every package's test suite (shard 4/4)             | 16        |
| test         | Run every package's test suite (shard 1/4)             | 13        |
| test         | Require all four shards green                          | 4         |
| browser-test | Upload this shard's JSON report                        | 3         |
| browser-test | Install the Chromium browser Playwright drives         | 3         |
| browser-test | Cross-reference changed copy against the browser suite | 3         |
| test         | Prove the shards' union covers every package           | 2         |
| test         | Run every package's test suite (shard 2/4)             | 2         |
| browser-test | Prove the browser suite actually executed              | 2         |
| test         | Run actions/download-artifact@v8                       | 1         |

#### Full-day census 2026-09-15 (UTC): 1053 non-skipped runs, 1841 executed jobs, 9,196 job-minutes (153 runner-hours)

| workflow              | event        | jobs | job-minutes | share |
| --------------------- | ------------ | ---- | ----------- | ----- |
| browser-test          | merge_group  | 200  | 2,863       | 31%   |
| test                  | merge_group  | 200  | 2,326       | 25%   |
| test                  | pull_request | 205  | 1,331       | 14%   |
| lint                  | pull_request | 41   | 265         | 3%    |
| lint                  | merge_group  | 40   | 253         | 3%    |
| harness-windows       | merge_group  | 40   | 207         | 2%    |
| typecheck             | pull_request | 41   | 196         | 2%    |
| typecheck             | merge_group  | 40   | 192         | 2%    |
| harness-windows       | pull_request | 41   | 185         | 2%    |
| Desktop Smoke         | push         | 18   | 147         | 2%    |
| CLI Smoke Test        | push         | 135  | 144         | 2%    |
| CLI Smoke Test        | pull_request | 135  | 144         | 2%    |
| claude-code-review    | pull_request | 34   | 131         | 1%    |
| site-build            | merge_group  | 40   | 119         | 1%    |
| docs-openapi-check    | merge_group  | 40   | 111         | 1%    |
| scripts-test          | pull_request | 38   | 90          | 1%    |
| docs-openapi-check    | pull_request | 41   | 66          | 1%    |
| site-build            | pull_request | 41   | 60          | 1%    |
| scripts-test          | push         | 22   | 54          | 1%    |
| credential-free-build | pull_request | 5    | 49          | 1%    |

Job queue wait that day (all jobs, attempt 1): median 2s, p75 2s, p90 3s, p99 14s, max 1.3m; jobs waiting >2m: 0, >5m: 0, >15m: 0
Runner labels: ubuntu-latest=1741, windows-latest=81, macos-latest=19
Peak concurrently-running jobs: 59 (at minute 1328 = 22:08Z); minutes with >=20 running: 181; >=15: 302; minutes with >=1 job queued: 29; peak queued: 19
Hourly peak running jobs (UTC 00..23): 23 16 0 0 0 1 0 0 0 0 27 15 27 11 22 40 35 46 47 40 39 45 59 31
Hourly peak queued jobs (UTC 00..23): 4 0 0 0 0 0 0 0 0 0 4 4 19 0 16 1 1 11 16 1 16 17 4 0

Estimated job-minutes per ISO week (per-workflow mean job-minutes/run from samples x run counts): 2026-W34=34,193 (570h), 2026-W35=63,748 (1,062h), 2026-W36=106,707 (1,778h), 2026-W37=59,718 (995h), 2026-W38=27,682 (461h)
Mean job-minutes per run used: browser-test/merge_group=67.3 (n=67), test/merge_group=53.5 (n=68), test/pull_request=31.2 (n=70), credential-free-build/pull_request=12.2 (n=4), Desktop Smoke/push=7.7 (n=19), Desktop Smoke/pull_request=7.6 (n=1), lint/pull_request=6.3 (n=68), lint/merge_group=6.3 (n=69), CLI Smoke Test/push=5.3 (n=27), CLI Smoke Test/pull_request=5.3 (n=27), typecheck/merge_group=5.2 (n=68), harness-windows/merge_group=5.2 (n=40), typecheck/pull_request=5.0 (n=67), scripts-test/push=4.9 (n=11)
