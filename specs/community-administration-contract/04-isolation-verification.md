# Administration isolation verification

Status: in progress. Refs DOR-2178. This receipt covers one strengthened deletion proof, not the full administration acceptance matrix.

The real HTTP/PostgreSQL deletion journey now keeps another active community populated with a private channel, a posted attachment, and an authenticated live stream while the target community is deleted. The existing journey includes an in-flight export, uncertain blob cleanup, an injected provider failure, and a later worker retry.

Before deletion, the test records every surviving-community row in every public table with a `community_id` column, plus its community row. After deletion, that manifest is identical. The same browser session can still read that community, its private file bytes are unchanged, and the already-open stream delivers a newly posted message. This strengthens the previous check, which only proved a second community row remained.

The content-free deletion receipt is also tested before and after its thirty-day expiry. The fixture moves the request, completion, and expiry together to preserve the database's time constraints.

Verification:

- Administration PostgreSQL suite: **12 passed** after the final change, using one worker and the existing deadlines.
- Fault-injection sensitivity: deliberately deleting the surviving community's blob during the failed worker attempt makes the new download assertion fail (`404` rather than `200`). The original test source was restored afterward. An earlier injection after an unreachable retry branch did not execute and is not counted as mutation evidence.
- The first expiry fixture changed only its expiry and correctly failed the database constraint. The corrected fixture preserves the required thirty-day relationship; the final suite passes.
- The owned local PostgreSQL container was stopped after verification.

Remaining: independent review, composed acceptance with the final membership/navigation changes, the complete permission/upgrade matrix, and a coordinated backup/restore rehearsal. No live deployment or production data was changed by this proof.
