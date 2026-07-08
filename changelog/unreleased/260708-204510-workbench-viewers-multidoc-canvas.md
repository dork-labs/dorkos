### Added

- Viewer matrix + CodeMirror editor + multi-document canvas (DOR-219)
- The right-panel Canvas now holds several open documents at once, with a tabbed strip to switch between them and close buttons per tab. Open a file, image, page, or agent-generated view without losing the others.
- New in-canvas viewers: a code/text editor with syntax highlighting and save-back (409-safe reload/overwrite), a 3D model viewer (glTF/GLB/STL/OBJ) with orbit and zoom, and a CSV table viewer. Images gain scroll/drag zoom and pan.
- Agents (and, soon, the file explorer) can open a file straight into the canvas; the right viewer is chosen automatically from the file type. A `workbench.defaultViewers` config setting lets you override which viewer opens a given extension.

### Changed

- Editing protection is now per-document: you can edit one canvas document while agents keep updating the others.

### Fixed

- Clear per-document canvas edit-protection on editor unmount (DOR-219 review)
