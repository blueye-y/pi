# Changelog

## [Unreleased]

## 0.9.8

- **Renamed to `pi-vision`** (was `pi-vision-handoff`): the command is now `/vision` (was `/vision-handoff`), the config file `pi-vision.json` (was `pi-vision-handoff.json`, migrated automatically on first read), the entry file `vision.ts`, and the error-log directory `logs/pi-vision`. Internal identifiers (usage entry `vision:usage`, async message `vision-async`, paste preview `vision-paste-preview`) follow the rename.
- **Marker-based clipboard paste** (integrated from [@pi-archimedes/image-paste](https://www.npmjs.com/package/@pi-archimedes/image-paste), opt-in `clipboardPaste`): the paste key reads the clipboard image **directly** and inserts an `[Image #N]` marker; on submit the markers are replaced with real image blocks attached to the message, which the handoff then describes. No temp file, no read-tool dependency. `[Image #N]` markers are stripped from the submitted text.
- **Editor-intercepted paste key**: `ctrl+v` is intercepted in the extension's editor wrapper (before pi's built-in paste) instead of registered as a shortcut, so pi reports no "Extension shortcut conflict". `alt+v`/`ctrl+alt+v` are not registered (redundant); on macOS `super+v` (Command+V) is registered for terminals that forward it as a key sequence.
- **Cross-platform clipboard readers**: native `@mariozechner/clipboard`, `wl-paste` (Wayland), `xclip` (X11), PowerShell (Windows incl. WSL), plus a macOS osascript/JXA reader (NSPasteboard, TIFF→PNG via `sips`) and an HTML-clipboard fallback that extracts and downloads the image from apps that copy images as HTML (e.g. Feishu docs: `data-ace-gallery-json` / signed `<img src>` download URL).
- **`/vision paste`** (no args): paste the clipboard image into the editor without a keyboard shortcut — works even when the terminal swallows the paste key.
- **Auto-reload on toggle**: `/vision paste on|off` reloads pi automatically so the config-gated shortcut/editor interception takes effect immediately.
- **Paste-time prewarm** reuses `prewarmPastedImages`: a pasted image is described by the vision model while you type (fire-and-forget), so the description is a cache hit at submit.
- New tests for the paste queue/input transform, clipboard readers, HTML extraction/download, config migration, and shortcut registration (264 unit tests total).
