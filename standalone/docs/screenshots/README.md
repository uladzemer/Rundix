# Screenshot sources

`chat-dark.jpg` and `access-modes.jpg` show the real UI assets from Rundix 0.1.1, rendered in Chrome. Their text and account state are explicitly synthetic; no real account, credential, private path, conversation or model call was used. The model label "Codex" is a generic demo label, not a claim about an available model ID.

The images capture the 900 × 720 demo panel. Only the panel area is included, with no browser chrome or native VS Code editor-tab frame. UI controls and messages are rendered by the production webview scripts and styles, not drawn over the screenshots. The preview sets VS Code theme tokens and panel dimensions; it does not modify the production styles.

To reproduce the scene, run from the repository root:

```powershell
node standalone/docs/screenshots/preview.cjs
```

Open the printed loopback URL. It serves only the fixed demo page and the extension's `ui/` JavaScript/CSS assets. No CLI or user storage is connected, and sending messages cannot execute a task. For the menu image, open **Permissions**. A light-theme Russian question example is available at `/?theme=light&scene=questions`.

Capture the demo panel after layout has settled, inspect every image for clipping and personal information, then close the browser preview and stop the server. This folder is documentation and is excluded from the VSIX; updating screenshots does not require rebuilding or replacing the published extension.
