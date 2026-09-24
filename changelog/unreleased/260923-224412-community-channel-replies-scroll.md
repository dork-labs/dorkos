---
covers:
  - 'fix(client): reach the newest message in one Scroll to bottom press (DOR-2268)'
  - 'fix(client): keep a community channel steady when its connection is re-checked (DOR-2268)'
  - 'feat(community): show the reply count under a thread root in community channels (DOR-2229)'
---

### Added

- See how many replies a thread has in a community channel. The count sits under the message that started the thread, the same way it does in your own channels, and it goes up as new replies arrive. Click it to open the thread. A community running an older version of its server shows no count until it updates. (DOR-2229)

### Fixed

- Reach the newest message with one press of Scroll to bottom, even right after a lot of messages arrive at once. Before, it could stop partway and take two to four presses. (DOR-2268)
- See your own message in a community channel as soon as you send it. Every half minute the channel used to quietly reload itself, and a message sent at that moment could take around twenty seconds to show up. (DOR-2268)
