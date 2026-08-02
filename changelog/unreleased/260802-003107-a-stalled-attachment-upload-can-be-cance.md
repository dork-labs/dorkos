---
covers:
  - 'fix(chat): a stalled attachment upload can be cancelled, and gives up on its own (DOR-494)'
---

### Fixed

- An attachment that got stuck uploading used to freeze the whole message box — the send button spun forever and the Enter key stopped working, with no way out but a page reload. Now you can stop an upload: click the spinner where the send button sits, press Escape, or click the X on the file. And if the connection dies mid-upload, DorkOS gives up after 30 seconds and tells you on the file itself, so you can try again or drop it and carry on. A big file on a slow connection is left alone — only silence counts as trouble, not slowness. (DOR-494)
