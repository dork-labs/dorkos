---
covers:
  - 'feat(site): the comparison pages state what DorkOS is, in fewer words (DOR-1557)'
  - 'feat(site): the DorkOS answer leads the comparison recommendation, in green (DOR-1557)'
  - 'refactor(site): a comparison cell type that admits an unscored dimension (DOR-1557)'
  - 'fix(site): review fixes — restore the scope words the condense pass widened (DOR-1557)'
---

### Changed

- The comparison pages at dorkos.ai/compare stopped hedging about DorkOS. They used to describe DeepSeek Harness as the closest thing to what DorkOS "is trying to be", which reads like a product that has not decided what it is yet. DorkOS is something. The pages now say so, and every other soft phrase about our own product went with it (DOR-1557)
- Every verdict, answer and explanation on those pages got shorter again. Nothing was dropped: the facts, the credit we give other tools, and the places we say they beat us are all still there, in fewer words (DOR-1557)
- "Which one is for you" now opens with the reasons to pick DorkOS, instead of reaching them after a panel about the other tool. It reads that way on a phone and on a desktop, and the DorkOS ticks are green so the two lists are easy to tell apart at a glance (DOR-1557)
