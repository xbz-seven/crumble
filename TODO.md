# TODO

stuff i might get to eventually

## bugs

- drag & drop in pack tab only gives file names, not full paths (need to fix in tauri)
- scan button stays enabled after unpacking everything, should reset
- duplicate file detection is kinda naive

## features

- [ ] progress bar during pack/unpack (already have the events stubbed in rust)
- [ ] remember last directory between sessions
- [ ] .desktop file mime association (done but needs testing)
- [ ] compress level slider (zstd goes 1-22, default 22 is slow on big files)
- [ ] dark mode maybe

## refactors

- the whole tree renderer is O(n^2) for deep dirs, should be fine for normal use
- replace inline confirm dialog with tauri-plugin-dialog at some point
- split main.ts into multiple files before it gets worse
- bump zstd to 0.13? idk what version is current

## maybe

- add support for splitting large archives into multiple .crumbs parts
- could use serde instead of manual binary encoding for payload but meh
