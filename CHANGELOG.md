# Changelog

All notable changes to the **LabVIEW VI Support** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Changed

- `activationEvents` changed from `onStartupFinished` to `onCustomEditor:labview-vi-support.viEditor` — the extension now activates on demand only when a `.vi` or `.vit` file is opened, eliminating unnecessary startup overhead.

### Removed

- Removed the `labview-vi-support.helloWorld` scaffold command (was a `yo code` boilerplate leftover with no functional purpose).
- Removed legacy one-shot VBS workers (`save_vi_panel_image_worker.vbs`, `read_vi_props_worker.vbs`, `write_vi_props_worker.vbs`) in favor of the persistent session host.

### Fixed

- Fixed a potential temporary-directory leak in the preview export pipeline: the export working directory is now always cleaned up even when errors propagate past normal cleanup paths.

---

## [0.0.1] — 2026-05-01

### Added

- Custom editor (`labview-vi-support.viEditor`) for `.vi` and `.vit` files with three view modes: **both** (preview + properties table), **table-only**, and **preview-only**.
- Front panel/block diagram image export and VI property reading/writing via LabVIEW COM (driven by `labview_session_host.vbs`).
- Persistent LabVIEW session host (`labview_session_host.vbs`) for reduced COM connection overhead across multiple operations.
- Automatic LabVIEW version detection from the Windows registry; configurable via the **Configure LabVIEW Version** command.
- Property cache keyed by file path and content hash; manual cache clear via the **Clear Cache** command.
- `labview-vi-support.cacheDirectory` setting (machine-scoped, auto-maintained by the extension).
- `labview-vi-support.viewMode` setting (window-scoped default view mode).
- `labview-vi-support.scriptTimeoutMs` setting (timeout for worker pipeline invocations).
- Commands: **Open Cache Directory**, **Clear Cache**, **Configure LabVIEW Version**.
- Status bar item showing the active LabVIEW version for the currently focused file.
- Inline property editing with enum dropdowns, boolean toggles, and text fields.
- 250 ms debounced reload on external LabVIEW saves (file-watcher integration).

---

> For detailed documentation changes, see [`.doc/CHANGELOG.md`](.doc/CHANGELOG.md).
