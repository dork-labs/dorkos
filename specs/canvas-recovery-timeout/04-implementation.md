# Canvas recovery timeout implementation

**Issue** DOR-4757

**Status** Complete

**Progress** 1 of 1 task complete

Worker `/root/decompose_2402` prepared the test change in the dedicated worktree. The coordinator reviewed it under `REVIEW.md`. One options argument applies the existing 20-second ceiling to the three identity-hold cases. Their recovered work still settles exactly once. The helper and all assertions are unchanged.

The guarded, one-worker focused run passed 14 tests with zero retries. Full verification at `70442bf230acdbe842307d0ce904e44e81c3a7a8` passed. In that run the canvas file passed all 14 tests, the server passed 47,668 tests with 92 skipped, and all 24 affected test tasks finished successfully. The implementation source is unchanged in this task status update.

The old file at baseline `8ee317547876f16ded66d271016c515e88e14fe0` matched the exact file in the earlier full suite. That run's five-second timeout on the `in_doubt` case reproduced the issue. The associated isolated replay passed, so the evidence describes a load-sensitive timeout.
