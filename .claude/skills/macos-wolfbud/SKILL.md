---
name: macos-wolfbud
description: The native macOS WolfBud face in macos/. Use when editing that app, its SceneKit wolf, its ElevenLabs call, or the hub's choice of face (native app or Chrome) in mods/wolfbud/bridge/server.mjs. Load together with swiftui-expert-skill, swiftui-pro, swift-concurrency, swift-testing-expert, and swiftui-ui-patterns.
---

# Native WolfBud

The app is the face of the hub. It does not replace the Claude Code mod. Build and run steps are in `macos/README.md`. Package pins (ElevenLabs, GLTFKit2, Swift 5 language mode, macOS 15) live in `macos/Package.swift`. Leave the language mode: the ElevenLabs package is Swift 5.

## Face

`showFace` in `mods/wolfbud/bridge/server.mjs` picks the window. The candidate order is `nativeAppPath` in that file. `WOLFBUD_NO_WINDOW=1` returns before any spawn, which is how the hub tests stay quiet. `WOLFBUD_FACE=chrome` skips the app. `WOLFBUD_FACE=native` with no bundle logs and opens Chrome.

The scene is one `Window`. It quits when that window closes, and it stays visible while Claude is the active app. A `UtilityWindow` hides when inactive, so it cannot be the face.

## What has to stay in parity

- Tool names, announcement wording, SSE events, and page posts match `window/src` and `WolfBudCore`. Change both sides.
- Jaw, nod, and camera constants match `window/src/wolf.ts` and `WolfViewport.swift`. Change both.
- The app reads `windowKey` from `~/.wolfbud/hub.json`. It never reads `token`. The API key stays in the hub, which mints the conversation token.
- `updateContext` on the pinned Swift SDK appends. The web client can replace a note under a context id. Send the same text. There is no id argument.
- Per-frame jaw and listen levels live on `WolfDriver` (`OSAllocatedUnfairLock`). `SessionStore` changes when an event arrives, not on each frame.
- Colors are the `Theme` tokens taken from `window/src/style.css`.

## Checks

From `macos/`: `swift test`. Then `pnpm macos:build` and launch the `.app`. If `server.mjs` changed, run the mod loop in `Claude.md` as well.
