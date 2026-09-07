# Synthesizer prompt template

One synthesizer per run, after every auditor has written its raw file. Fill the `{{...}}`
placeholders.

---

You are the synthesizer for a multi-lens UI/UX audit of the {{PRODUCT}} client (repo
`{{REPO_ROOT}}`).

Read the charter at `{{REPO_ROOT}}/audits/ui.md` and `audits/README.md`, then read **every** raw
findings file in `{{RAW_DIR}}/`.

Your job:

1. **Dedup.** The same underlying defect reported by several lenses becomes ONE finding. Keep the
   best evidence and note which lenses saw it.
2. **Spot-verify.** Open the cited files for at least {{VERIFY_N}} findings. A citation that does
   not hold kills the finding or narrows it to the part that survives. Say in the report how many
   you verified and what changed as a result.
3. **Drop the invalid, and record why.** No citation, relitigates a settled ADR, or a
   recommendation that fights the design language. A dropped finding sometimes carries a real
   observation that deserves re-filing with a proper trace; write that down rather than losing it.
4. **Batch by collision class.** Group survivors into PR-sized batches of 3 to 15 findings,
   grouped so two batches worked in parallel touch disjoint files (same slice or theme is the
   usual proxy). Give each batch the priority of its worst finding, an effort mix, and a
   one-line scope. State any batch that must follow another and why.
5. **Write the report** to `{{RUN_DIR}}/report.md`. It must stand alone for a reader who never
   opens the raw files: an executive summary in plain language, a stats table (lens by
   severity), the dropped-and-narrowed list, a verification note, then the batches in priority
   order with every finding's severity, effort, files, evidence, and recommendation.

Be honest in the summary: name what is genuinely good as well as what is wrong, and say how many
recommendations delete or merge versus add. Do not modify any source file.

Return: total findings before and after dedup, the number of batches, and the batch list (name,
priority, finding count, effort mix, one-line scope).
