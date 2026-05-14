# vsc-labview-vi-support

A Visual Studio Code extension that previews and edits LabVIEW VI (`.vi`)
and template (`.vit`) files.

## Features

- **Custom editor for `.vi` / `.vit`** — opening a VI in VS Code shows a
  WebView with the front panel (FP) and block diagram (BD) rendered as
  images, plus an editable property table.
- **Toolbar** — switch between *FP Only*, *BD Only*, and *Both*; toggle the
  property table; zoom in/out (10 % – 500 %), reset.
- **Pan & zoom** — mouse wheel to zoom, drag to pan, double-click to fit.
- **Editable properties** — string, boolean, number, and enum (`ReentrantType`,
  `Priority`) controls. Changes are written back through the VI Server (via
  the bundled Python/VBScript scripts) and the file is re-saved.
- **MD5 cache** — VI artifacts (FP/BD images and properties JSON) are
  cached under the extension's global storage keyed by the MD5 of the
  source `.vi` file. Re-opening a previously inspected VI is instantaneous.

## Requirements

The extension shells out to bundled Python prototype scripts
(`prototype/scripts/*.py`) which in turn drive LabVIEW through ActiveX/COM:

- **Windows only** — the VI Server bridge is COM-based.
- **LabVIEW must be installed** matching the saved version of the VI
  (the scripts auto-discover the right install / bitness from the VI
  header).
- **Python 3** must be available on `PATH` (or set
  `labview-vi-support.pythonPath`).

## Settings

- `labview-vi-support.pythonPath` — override the Python executable.
- `labview-vi-support.scriptTimeoutMs` — per-script timeout in milliseconds.

## Status of the writer

`write_vi_props.py` and `write_vi_props_worker.vbs` mirror the structure of
the read scripts and target the 15 properties marked `R/W` in
`read_vi_props.py`'s metadata. They are best-effort and have been authored
without access to a real LabVIEW environment — please validate against
your installation before relying on them in production.

## Development

```bash
npm install
npm run compile          # check-types + lint + esbuild
npm run test:unit        # mocha tests for pure-logic modules (no VS Code)
npm test                 # full integration tests (requires VS Code download)
```