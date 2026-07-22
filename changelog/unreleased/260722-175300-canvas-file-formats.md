### Added

- Open 3D models, audio, and video files right in the canvas, plus every text file a project contains. New audio/video viewers play inline, and the 3D viewer now loads 3MF/PLY/FBX/DAE models alongside glTF/GLB, STL, and OBJ (DOR-420)
- Audio and video are new media types that stream from the server, so playback can seek to any point mid-file without downloading the whole clip (this uses HTTP Range requests). An unsupported binary shows a friendly in-canvas message instead of breaking the canvas (DOR-420)

### Fixed

- Opening and closing 3D files over and over no longer piles up graphics memory. When you close a model, the viewer now frees its geometry, material, and texture resources, and an unused material fallback was removed (DOR-420)
