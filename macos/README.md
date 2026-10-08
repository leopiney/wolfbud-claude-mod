# WolfBud for macOS

The native face of the WolfBud hub. It shows the 3D wolf, the ElevenLabs call, the Claude session roster, captions, and the activity feed. The hub in `mods/wolfbud/bridge/server.mjs` opens this app when `WolfBud.app` is installed, and opens the Chrome window otherwise.

## Build and run

macOS 15 or later. From the repo root:

```bash
pnpm macos:build
open macos/.build/WolfBud.app
```

Run the `.app`. `swift run` has no mic usage string and no local-network exception, so the call and the hub connection fail there. The first call asks for the microphone.

The app reads `windowKey` and `port` from `~/.wolfbud/hub.json`. It does not read the service token, and the ElevenLabs API key stays in the hub. Start a session with `/wolfbud` so that file exists. With the app installed, `/wolfbud` opens it. `WOLFBUD_FACE=chrome` keeps the Chrome window. `WOLFBUD_APP` points at a bundle somewhere else.

`macos/.build/` is generated. The model is copied from `window/public/wolf-head.glb`.

## Checks

```bash
cd macos && swift test
```

`pnpm macos:build` is the release bundle. A change to `mods/wolfbud/bridge/server.mjs` still goes through the mod loop in the repo `Claude.md`.
