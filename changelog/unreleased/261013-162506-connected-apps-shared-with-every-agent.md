---
covers:
  - 'feat(trust): a connected app is shared with every agent on Trusted (DOR-2739)'
  - '#2865'
---

### Changed

- On Trusted, an app you connect is shared with every agent right away, including agents you add later, at **Read and write**, or **Read** where that is all the app offers. Pick **Only agents you pick** in **Who can use it?** to narrow it. Deleting things still needs you to allow it one action at a time, and on Careful nobody can use a new app until you choose (DOR-2739)
- The first time DorkOS starts on Trusted after this update, each connected app no agent could use yet is shared with every agent the same way, once. An app you had already given to some agents stays exactly as it was (DOR-2739)
- The one-time "Agents now work without asking" note lists the apps it shared, each with **Choose agents**, which opens that app's **Who can use it?** so you can pick agents one by one. If you had already dismissed the note, it shows once more to name them (DOR-2739)
