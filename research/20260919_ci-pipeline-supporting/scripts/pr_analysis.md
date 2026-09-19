### Window 30d: 779 merged PRs

#### Open -> merged (createdAt -> mergedAt)

| Segment                         | n   | median | p75  | p90  | mean |
| ------------------------------- | --- | ------ | ---- | ---- | ---- |
| all                             | 779 | 60m    | 2.0h | 4.7h | 2.8h |
| size XS (<10)                   | 10  | 50m    | 87m  | 2.7h | 83m  |
| size S (10-49)                  | 34  | 39m    | 57m  | 1.9h | 57m  |
| size M (50-249)                 | 135 | 50m    | 1.6h | 3.4h | 1.9h |
| size L (250-999)                | 283 | 58m    | 1.8h | 3.9h | 2.5h |
| size XL (1000+)                 | 317 | 71m    | 2.5h | 6.0h | 3.7h |
| label `skip-changelog`          | 238 | 43m    | 84m  | 3.0h | 1.7h |
| label `review:light`            | 235 | 52m    | 1.6h | 3.2h | 2.1h |
| label `skip-review`             | 32  | 74m    | 2.9h | 7.9h | 6.5h |
| label `review:deep`             | 26  | 1.8h   | 2.5h | 4.8h | 2.7h |
| no review:* / skip-review label | 486 | 61m    | 2.1h | 4.9h | 2.9h |
| was ever draft                  | 5   | 4.6h   | 6.9h | 7.2h | 5.1h |
| never draft                     | 774 | 60m    | 2.0h | 4.6h | 2.8h |
| dependabot                      | 0   | -      | -    | -    | -    |

#### Stage intervals

| Segment                                        | n   | median | p75  | p90  | mean |
| ---------------------------------------------- | --- | ------ | ---- | ---- | ---- |
| created -> last ready-for-review (drafts only) | 5   | 1.6h   | 2.7h | 4.3h | 2.4h |
| ready -> first Claude review comment           | 691 | 4m     | 5m   | 7m   | 6m   |
| created -> auto-merge armed (first)            | 647 | 0m     | 0m   | 12m  | 16m  |
| ready -> auto-merge armed (first)              | 644 | 0m     | 0m   | 13m  | 17m  |
| first Claude review -> armed                   | 88  | 19m    | 62m  | 3.3h | 67m  |
| armed (first) -> queue entry (first)           | 647 | 17m    | 35m  | 80m  | 57m  |
| created -> queue entry (first)                 | 779 | 23m    | 55m  | 2.0h | 73m  |
| queue entry (first) -> merged                  | 779 | 28m    | 48m  | 2.0h | 1.6h |
| queue entry (last) -> merged                   | 779 | 26m    | 35m  | 56m  | 34m  |
| time resident in queue (sum of stints)         | 779 | 28m    | 44m  | 83m  | 50m  |
| queue (last) -> merged, PRs never ejected      | 646 | 26m    | 34m  | 52m  | 33m  |
| first commit (authored) -> merged              | 779 | 2.0h   | 3.8h | 8.4h | 4.7h |
| last commit -> merged                          | 779 | 58m    | 83m  | 2.4h | 87m  |

- Armed via auto-merge: 647/779; entered queue: 779/779; queue entries total 1116 (1.43/PR)
- PRs ejected at least once: 134 (17%); ejected for failed_checks at least once: 99 (13%)
- Ejection reasons (events): failed_checks=247, merge_conflict=45, manual=42, invalid_merge_commit=2, git_tree_invalid=1, checks_timed_out=1
- Queue entries per PR: 1x=646, 2x=82, 3x=23, 4x=9, 5+x=19
- Commits/PR: median 2, p90 8, mean 3.8, max 44
- Force-pushes/PR: median 0, p90 1, mean 0.23; PRs with >=1 force-push: 110 (14%)
- PRs with a Claude review comment: 691; with `re-review` label applied: 58 (75 re-reviews)
- Size mix: L (250-999)=283, M (50-249)=135, S (10-49)=34, XL (1000+)=317, XS (<10)=10
- Lines changed: median 720, p90 3518
- PRs opened in window: 783 -> merged 774, closed unmerged 8, still open 1
- Merges/day: 25.7 (window length 30.3 days)

### Window 7d: 116 merged PRs

#### Open -> merged (createdAt -> mergedAt)

| Segment                         | n   | median | p75  | p90  | mean |
| ------------------------------- | --- | ------ | ---- | ---- | ---- |
| all                             | 116 | 58m    | 1.6h | 3.0h | 1.9h |
| size XS (<10)                   | 2   | 36m    | 36m  | 36m  | 36m  |
| size S (10-49)                  | 6   | 44m    | 60m  | 73m  | 50m  |
| size M (50-249)                 | 19  | 55m    | 1.8h | 3.5h | 2.6h |
| size L (250-999)                | 35  | 46m    | 72m  | 84m  | 58m  |
| size XL (1000+)                 | 54  | 69m    | 2.2h | 4.9h | 2.4h |
| label `skip-changelog`          | 46  | 41m    | 75m  | 1.9h | 69m  |
| label `review:light`            | 34  | 46m    | 82m  | 2.4h | 76m  |
| label `review:deep`             | 7   | 1.8h   | 2.2h | 3.4h | 2.1h |
| no review:* / skip-review label | 75  | 60m    | 1.6h | 3.4h | 2.2h |
| was ever draft                  | 0   | -      | -    | -    | -    |
| never draft                     | 116 | 58m    | 1.6h | 3.0h | 1.9h |
| dependabot                      | 0   | -      | -    | -    | -    |

#### Stage intervals

| Segment                                        | n   | median | p75  | p90  | mean |
| ---------------------------------------------- | --- | ------ | ---- | ---- | ---- |
| created -> last ready-for-review (drafts only) | 0   | -      | -    | -    | -    |
| ready -> first Claude review comment           | 110 | 4m     | 6m   | 7m   | 6m   |
| created -> auto-merge armed (first)            | 84  | 0m     | 6m   | 39m  | 24m  |
| ready -> auto-merge armed (first)              | 84  | 0m     | 6m   | 39m  | 24m  |
| first Claude review -> armed                   | 23  | 15m    | 49m  | 2.4h | 71m  |
| armed (first) -> queue entry (first)           | 84  | 10m    | 16m  | 36m  | 9m   |
| created -> queue entry (first)                 | 116 | 16m    | 42m  | 75m  | 35m  |
| queue entry (first) -> merged                  | 116 | 30m    | 53m  | 1.8h | 79m  |
| queue entry (last) -> merged                   | 116 | 30m    | 31m  | 48m  | 33m  |
| time resident in queue (sum of stints)         | 116 | 30m    | 47m  | 71m  | 43m  |
| queue (last) -> merged, PRs never ejected      | 90  | 30m    | 30m  | 44m  | 32m  |
| first commit (authored) -> merged              | 116 | 1.8h   | 3.8h | 8.2h | 5.6h |
| last commit -> merged                          | 116 | 55m    | 74m  | 1.7h | 66m  |

- Armed via auto-merge: 84/116; entered queue: 116/116; queue entries total 164 (1.41/PR)
- PRs ejected at least once: 26 (22%); ejected for failed_checks at least once: 20 (17%)
- Ejection reasons (events): failed_checks=35, manual=10, merge_conflict=3
- Queue entries per PR: 1x=90, 2x=16, 3x=5, 4x=3, 5+x=2
- Commits/PR: median 2.0, p90 13, mean 5.1, max 44
- Force-pushes/PR: median 0.0, p90 1, mean 0.26; PRs with >=1 force-push: 24 (21%)
- PRs with a Claude review comment: 110; with `re-review` label applied: 13 (19 re-reviews)
- Size mix: L (250-999)=35, M (50-249)=19, S (10-49)=6, XL (1000+)=54, XS (<10)=2
- Lines changed: median 841.5, p90 5285
- PRs opened in window: 116 -> merged 113, closed unmerged 2, still open 1
- Merges/day: 15.8 (window length 7.3 days)

#### Merges per day (30d)

| day        | merges |
| ---------- | ------ |
| 2026-08-20 | 23     |
| 2026-08-21 | 6      |
| 2026-08-22 | 24     |
| 2026-08-23 | 39     |
| 2026-08-24 | 48     |
| 2026-08-25 | 36     |
| 2026-08-26 | 24     |
| 2026-08-27 | 4      |
| 2026-08-28 | 23     |
| 2026-08-29 | 26     |
| 2026-08-30 | 1      |
| 2026-08-31 | 14     |
| 2026-09-01 | 16     |
| 2026-09-02 | 50     |
| 2026-09-03 | 60     |
| 2026-09-04 | 19     |
| 2026-09-05 | 42     |
| 2026-09-06 | 44     |
| 2026-09-07 | 41     |
| 2026-09-08 | 44     |
| 2026-09-09 | 31     |
| 2026-09-10 | 13     |
| 2026-09-11 | 35     |
| 2026-09-12 | 28     |
| 2026-09-13 | 8      |
| 2026-09-14 | 22     |
| 2026-09-15 | 29     |
| 2026-09-16 | 19     |
| 2026-09-17 | 2      |
| 2026-09-18 | 3      |
| 2026-09-19 | 5      |

Merges by UTC hour: 00:42 01:33 02:42 03:47 04:33 05:28 06:23 07:21 08:22 09:18 10:23 11:26 12:25 13:37 14:26 15:21 16:33 17:33 18:38 19:26 20:46 21:58 22:32 23:46

#### Most-ejected PRs (30d)

| PR    | queue entries | ejections                                               | first queue -> merged |
| ----- | ------------- | ------------------------------------------------------- | --------------------- |
| #1284 | 21            | {'failed_checks': 17, 'merge_conflict': 1, 'manual': 2} | 24.0h                 |
| #1520 | 19            | {'failed_checks': 14, 'merge_conflict': 4}              | 2.7d                  |
| #1231 | 15            | {'failed_checks': 13, 'manual': 1}                      | 5.0d                  |
| #1598 | 15            | {'failed_checks': 13, 'manual': 1}                      | 20.3h                 |
| #1524 | 14            | {'failed_checks': 12, 'merge_conflict': 1}              | 35.9h                 |
| #1309 | 13            | {'failed_checks': 11, 'manual': 1}                      | 9.1h                  |
| #1549 | 13            | {'merge_conflict': 5, 'failed_checks': 7}               | 22.4h                 |
| #1546 | 12            | {'merge_conflict': 3, 'failed_checks': 7, 'manual': 1}  | 43.7h                 |
| #1527 | 10            | {'failed_checks': 8, 'merge_conflict': 1}               | 23.2h                 |
| #1406 | 9             | {'failed_checks': 7, 'manual': 1}                       | 32.2h                 |
