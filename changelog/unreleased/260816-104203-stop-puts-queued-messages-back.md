---
covers:
  - 'feat(server,client): Stop puts your queued messages back instead of firing them (P4.7, DOR-1199)'
---

### Changed

- Pressing Stop while messages are waiting in line now stops everything, and puts those messages back in your composer instead of running them one by one. It asks first and tells you how many are coming back, so nothing you typed is lost and nothing fires after you've said stop. Stop with nothing waiting works exactly as before (DOR-1199).
