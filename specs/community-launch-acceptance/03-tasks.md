# Tasks: community-launch-acceptance

Spec: `specs/community-launch-acceptance/02-specification.md`. Generated 2026-09-30T03:22:20Z (full). Canonical list: `03-tasks.json`.

## Phase 1: Tooling and docs (no spend)

### Task 1.1: Add a capped hold and a second-person proof to the Community live gate

- Linear: DOR-2591
- Size: large; priority: high
- Depends on: none
- Parallel with: 1.3, 1.4, 1.5, 1.6

### Task 1.2: Let the two-Desktop driver run against an existing remote Community

- Linear: DOR-2592
- Size: large; priority: high
- Depends on: 1.1
- Parallel with: 1.3, 1.4, 1.5, 1.6

### Task 1.3: Prove the launcher and its community never need DorkOS Cloud

- Linear: DOR-2593
- Size: medium; priority: high
- Depends on: none
- Parallel with: 1.1, 1.4, 1.5, 1.6

### Task 1.4: Write backup and upgrade steps for a community made with guided setup

- Linear: DOR-2594
- Size: medium; priority: high
- Depends on: none
- Parallel with: 1.1, 1.2, 1.3, 1.5, 1.6

### Task 1.5: Write the attended live-run checklist for DOR-2170

- Linear: DOR-2595
- Size: small; priority: high
- Depends on: none
- Parallel with: 1.1, 1.2, 1.3, 1.4, 1.6

### Task 1.6: Draft the "Run your own community" guide page

- Linear: DOR-2596
- Size: medium; priority: high
- Depends on: none
- Parallel with: 1.1, 1.2, 1.3, 1.4, 1.5

## Phase 2: Attended live runs (paid)

### Task 2.1: Run the live journey and recovery check (L2)

- Linear: DOR-2597
- Size: medium; priority: high
- Depends on: 1.1, 1.2, 1.3, 1.4, 1.5
- Parallel with: 2.2, 2.3

### Task 2.2: Run the live failure, restricted-credential and interruption check (L3)

- Linear: DOR-2598
- Size: medium; priority: high
- Depends on: 1.5
- Parallel with: 2.1, 2.3

### Task 2.3: Run the fresh-account walkthrough (L4, operator-only)

- Linear: DOR-2599
- Size: medium; priority: high
- Depends on: 1.6
- Parallel with: 2.1, 2.2

## Phase 3: Evidence and publish

### Task 3.1: Record the DOR-2170 acceptance evidence

- Linear: DOR-2600
- Size: small; priority: high
- Depends on: 2.1, 2.2, 2.3
- Parallel with: none

### Task 3.2: Publish the Run your own community entry point

- Linear: DOR-2601
- Size: small; priority: high
- Depends on: 3.1, 1.6
- Parallel with: none

## Critical path

1.1 → 1.2 → 2.1 → 3.1 → 3.2 (plus DOR-2169's published-release gate PASS before any phase 2 run). Phase 1 tasks 1.3–1.6 run in parallel with 1.1.
