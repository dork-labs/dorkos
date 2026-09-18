---
covers:
  - 'feat(cloud-api): additive contract rows — top-up, refunds, member display name, remote windows, seat activity (DOR-2090)'
  - 'fix(cloud-api): keep the command outcome narrowable and make the enum registry read through a union (DOR-2090)'
  - 'feat(cloud-api): two inference refusal reasons — a daily limit and a spent turn budget (DOR-2090)'
  - 'docs(cloud-api): write down what a consumer owes an enum member it has never seen (DOR-2090)'
  - 'fix(cloud-api): make the doc-comment threshold guard a rule about numbers, not about English (DOR-2090)'
  - 'fix(cloud-api): the seat activity event names its organization orgId, like the rest of the package (DOR-2090)'
---

### Added

- The published cloud contract (`@dork-labs/cloud-api`) now describes buying credit and asking for a refund, including the three refusals that go with them, so an app can say what actually happened instead of guessing (DOR-2090)
- A person in an organization can be shown by name rather than by role alone, and a seat's permission list can show what it resolves to when no rule is set (DOR-2090)
- A remote connection now carries the two timing windows it is told to honour — how long it may sit idle, and how long it has to finish work in flight before it closes (DOR-2090)
- A new seat activity event, for anyone building fair billing on top: one per agent seat per subscription period, with nothing from any message in it (DOR-2090)
- Two new reasons an inference request can be turned down: a daily limit that resets, and a single turn that has used up its budget. Both are separate from "you are out of credit", because what you do about them is different (DOR-2090)

### Note for people upgrading

- No field was renamed or removed, and nothing you already send stops being accepted (DOR-2090)
- **New values can turn up on existing lists.** This release adds five: three new refusal codes and two new reasons an inference request can be turned down. Code that was built against an older release will meet a value it does not recognise, so show it rather than treating the answer as broken — the contract says what a consumer owes an unknown value, and the package README explains how the bundled client behaves until it can carry one (DOR-2090)
