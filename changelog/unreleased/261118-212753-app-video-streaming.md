---
covers:
  - 'feat(extensions): an app plays long video in its frame, with seeking (DOR-4321)'
---

### Added

- Apps can now play long videos. A video starts quickly, you can skip ahead, and there is no size limit. Apps that show pictures work as before. App makers use the new `api.mediaUrl`. (DOR-4321)

### Security

- A video link plays one video from one app and nothing else. It never acts as you, even though you opened the app. It stops working after 10 minutes unused, after 2 hours at most, and as soon as the app is turned off, reloaded or updated. The link never shows up in DorkOS's logs. (DOR-4321)
