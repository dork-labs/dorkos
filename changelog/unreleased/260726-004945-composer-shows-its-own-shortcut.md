---
covers:
  - 'feat(chat): the composer shows you the shortcut that wipes a draft (DOR-479)'
---

### Added

- Press Escape once while you have something typed and a quiet note now appears above the writing box: **Press Esc again to clear**. Pressing Escape twice has always wiped a draft, but the first press did nothing you could see, so nobody ever tried the second one. The note shows up only while that second press would really work, and it is gone the moment it would not (DOR-479)

### Fixed

- The composer said "Editing message —" with nothing after the dash. It now tells you which one you are rewriting: "Editing message 2 of 3" (DOR-479)
- "Session is busy. Please wait..." named nobody and gave no idea how long. It now says "Your agent is still finishing the last message. Try again in a moment." (DOR-479)
- The list of waiting messages told you how many there were but never when they would go out. It now says so: "Queued (2) — Waiting for the reply to finish" (DOR-479)
- A follow-up suggestion too long for its chip was cut off with no way to read the rest. Hover it and you get the whole line (DOR-479)
- While you edit a message that is waiting to send — the one mode where Enter saves instead of sends — the writing box had no name at all for a screen reader. It now announces "Edit queued message 2 of 3 — press Enter to save" (DOR-479)
- A file search that matched nothing could point a screen reader at a list that was not on the page (DOR-479)
- The paperclip and the clear (×) button showed no outline when you reached them with the keyboard (DOR-479)
- The list of waiting messages popped out of existence the instant the last one sent, instead of sliding away, and the extra stop button did the same. Both settle properly again (DOR-479)
- The composer's right edge jumped sideways the moment you typed your first character, and a waiting message shifted two pixels when you clicked to edit it. Neither moves now (DOR-479)
- A photo you attached rebuilt its little preview many times a second the whole time it was uploading. It is built once (DOR-479)
