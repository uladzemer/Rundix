# Screenshot and tour sources

## Full VS Code workbench tour

`demo.gif` is a 29-second tour of seven scenes from an actual VS Code Extension Development Host running the public Rundix source:

1. `workbench-overview.jpg`: three native editor tabs, grouped session tree and a code conversation.
2. `workbench-tests.jpg`: a second chat with a Markdown table and test examples.
3. `workbench-split.jpg`: a TypeScript file beside a chat in two real editor groups.
4. `workbench-queue.jpg`: two paused follow-up tasks and their queue controls.
5. `workbench-access.jpg`: access modes and reasoning controls.
6. `workbench-history.jpg`: session search with the three demo conversations.
7. `workbench-questions.jpg`: Russian questions in the light theme, with the native tabs still visible.

The complete workbench content area is captured, including its real title bar, native VS Code tabs, activity bar and session tree. No editor frame or tab strip is drawn over the images. The Extension Development Host label is intentionally visible. This is a feature tour through fixed synthetic scenes, not a recording of live model execution or typing.

`workbench-host.cjs` creates three synthetic sessions through the extension API. It supplies synthetic App Server replies and rejects model sends and sign-in operations. No real account, credential, private path, conversation or model call is used. The model label "Codex" is a generic demo label, not a claim about a particular available model ID.

To regenerate the full-window images and GIF on Windows, install the extension development dependencies and Python's Pillow package, then run from the repository root:

```powershell
node standalone/docs/screenshots/workbench-capture.cjs
```

The script launches installed VS Code through `workbench-demo.ps1` with a fresh user-data directory, empty extension directory, synthetic project and empty `CODEX_HOME`, all under the excluded `.verification/` directory. It changes settings only in that isolated profile. The user's installed extensions, settings, conversations and sign-in are not used or changed.

The fixture selects scenes through an excluded JSON control file unique to each run. An exclusive output lock refuses a second simultaneous capture. After an interrupted run, verify the capture has stopped before removing a stale `.verification/workbench-capture.lock`. The launcher opens a loopback-only Chromium debugging port for that isolated window; Puppeteer connects to it for read-only renderer screenshots, not for clicking or typing. The capture rejects an unexpected window title and requires a content area of at least 1280 by 800 pixels. The current captures are 1440 by 900. At completion it asks the fixture to finish, disconnects and checks the launched process exits. Startup and scene waits are bounded. `tour.py` encodes the seven still images into the GIF. Inspect each scene before committing it.

## Panel-only previews

The older `chat-dark.jpg`, `access-modes.jpg` and `questions-light.jpg` capture the production webview scripts in a 900 by 720 browser panel without VS Code's outer workbench. They remain useful for close-ups; the main tour uses the full-window captures above.

Run the browser-only preview from the repository root:

```powershell
node standalone/docs/screenshots/preview.cjs
```

It serves only a fixed synthetic page and the extension's `ui/` JavaScript/CSS on loopback. No CLI or user storage is connected, and sending cannot execute tasks. For the menu scene, open Permissions; `/?theme=light&scene=questions` shows Russian questions.

To regenerate these three panel close-ups and the installation badge:

```powershell
node standalone/docs/screenshots/capture.cjs
```

Set `CHROME_PATH` for a nonstandard Chrome/Chromium location. Set `PYTHON` when the Python executable for GIF generation has a different name or path.

## Installation badge and publication

`../branding/marketplace-badge.svg` is rendered to PNG by `capture.cjs`. It is a project-created installation-link graphic with a generic storefront symbol and plain text, under the project MIT license; it is not an official Microsoft logo or certification. The PNG avoids dependence on an external badge service and works with Marketplace image formats.

The Marketplace README uses public HTTPS image URLs pointing to these assets. This documentation folder, the capture scripts and the isolated profiles are excluded from the VSIX. Replacing an image at an existing URL does not require a new package; updating the packaged README text or bundled changelog does. Microsoft Marketplace remains the only advertised distribution channel. GitHub Actions remain disabled.
