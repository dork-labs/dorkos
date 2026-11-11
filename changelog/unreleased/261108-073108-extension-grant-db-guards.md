---
covers:
  - 'fix(db): an extension grant is read-only and its ids carry no hidden bytes, enforced by the database (DOR-3547)'
  - 'fix(db): an extension grant is read-only and its ids carry no hidden bytes, enforced by the database (#3536)'
---

### Security

- Make DorkOS's database refuse a mini app's grant to change anything in a connected app, and refuse approval records with hidden or blank values (DOR-3547)
