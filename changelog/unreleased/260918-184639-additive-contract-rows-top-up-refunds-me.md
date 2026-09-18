---
covers:
  - 'feat(cloud-api): additive contract rows — top-up, refunds, member display name, remote windows, seat activity (DOR-2090)'
---

### Added

- The published cloud contract (`@dork-labs/cloud-api`) now describes buying credit and asking for a refund, including the three refusals that go with them, so an app can say what actually happened instead of guessing (DOR-2090)
- A person in an organization can be shown by name rather than by role alone, and a seat's permission list can show what it resolves to when no rule is set (DOR-2090)
- A remote connection now carries the two timing windows it is told to honour — how long it may sit idle, and how long it has to finish work in flight before it closes (DOR-2090)
- A new seat activity event, for anyone building fair billing on top: one per agent seat per subscription period, with nothing from any message in it (DOR-2090)

### Note for people upgrading

- Every one of these is a new optional field or a new shape. Anything already built against the contract keeps working, and nothing was renamed or removed (DOR-2090)
