# Screenshot sources

`chat-dark.jpg`, `access-modes.jpg` and `questions-light.jpg` show the real Rundix UI assets, rendered in Chrome. `demo.gif` cycles through these three scenes over ten seconds. Their text and account state are explicitly synthetic; no real account, credential, private path, conversation or model call was used. The model label "Codex" is a generic demo label, not a claim about an available model ID.

The images capture the 900 × 720 demo panel. Only the panel area is included, with no browser chrome or native VS Code editor-tab frame. UI controls and messages are rendered by the production webview scripts and styles, not drawn over the screenshots. The preview sets VS Code theme tokens and panel dimensions; it does not modify the production styles.

To reproduce the scene, run from the repository root:

```powershell
node standalone/docs/screenshots/preview.cjs
```

Open the printed loopback URL. It serves only the fixed demo page and the extension's `ui/` JavaScript/CSS assets. No CLI or user storage is connected, and sending messages cannot execute a task. For the menu image, open **Permissions**. A light-theme Russian question example is available at `/?theme=light&scene=questions`.

Capture the demo panel after layout has settled, inspect every image for clipping and personal information, then close the browser preview and stop the server. This folder is documentation and is excluded from the VSIX; updating screenshots does not require rebuilding or replacing the published extension.

To regenerate all three still images and the GIF, install the extension's development dependencies and Python's Pillow package, then run from the repository root:

```powershell
node standalone/docs/screenshots/capture.cjs
```

Set `CHROME_PATH` if Chrome/Chromium is outside the listed locations. Set `PYTHON` if the Python executable has a different name or path. The capture script starts and stops its own loopback server and headless browser, opens the access menu through the normal webview event, and captures the light-theme Russian question scene. `tour.py` encodes those still captures as an animated GIF. Inspect all three scenes before committing. The GIF is a feature tour, not a recording of live model execution.

The script also renders `../branding/marketplace-badge.svg` to PNG for GitHub and Marketplace. This is a project-created installation link graphic with a generic storefront symbol and plain text, under the project MIT license; it is not an official Microsoft logo or certification. The PNG avoids dependence on an external badge service and works with Marketplace's image formats.

The Marketplace README uses public HTTPS image URLs pointing to this folder. Updating that packaged README or its bundled changelog requires a new extension package, even though the image files themselves stay outside the VSIX.
