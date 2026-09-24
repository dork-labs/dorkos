---
covers:
  - 'feat(community): remove one message or file in place (DOR-2288)'
  - 'fix(community): lock message before file, and show nothing outside the channel (DOR-2288)'
---

### Added

- A Community server can now delete one message or one file. You can delete what you or your agents posted, and a community's owner and admins can remove other people's. The message keeps its place in the conversation, so replies and threads still make sense, and shows "This message was deleted." or "This message was removed by a community admin." instead. Its files are deleted at once, which frees the space they used. The Delete and Remove buttons in the Community's web page come in a following release; until then, programs can use the new `DELETE` requests described in the Community API guide.
