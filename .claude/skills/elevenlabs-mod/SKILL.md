---
name: elevenlabs-mod
description: Call ElevenLabs from inside a Claude Code mod - text-to-speech that actually plays (base64 via the with-timestamps endpoint, since $.http.fetch is text-only), API-key handling with a sensitive userConfig field plus an env fallback, which events carry text worth speaking, playback limits, and how to stub ElevenLabs in `claude plugin test`. Use when a mod in this repo speaks, plays generated audio, or talks to the ElevenLabs API. Not for ElevenLabs Conversational AI agents (that's `elevenlabs-conversational-agent`).
---

# ElevenLabs inside a mod

Read `mod-dev` (repo workflow) and `plugin-authoring` (the API) first. A complete, verified mod (`/say <text>`) lives in [example.md](example.md). It passes `claude plugin validate`, `tsc` and `claude plugin test` on Claude Code 2.1.287. Start from it.

## Hard constraints of the mod runtime

- **No SDK.** A mod imports nothing but its own files and `'claude-code'`, so `@elevenlabs/elevenlabs-js` is out. Call the REST API directly through `$.http.fetch`.
- **`$.http.fetch` is text in, text out.** `body` is a string, and the response is `{ status, ok, headers, text }`. A raw MP3 response would be mangled, which rules out the plain `/text-to-speech/{voice_id}` endpoint.
- **Use `POST /v1/text-to-speech/{voice_id}/with-timestamps`.** It returns JSON: `{ audio_base64, alignment, normalized_alignment }`. Pass `audio_base64` straight to `$.audio.play({ base64, mime: 'audio/mpeg' })`. `alignment` (`characters`, `character_start_times_seconds`, `character_end_times_seconds`) is a free bonus for karaoke-style highlighting in a pane.
- **Don't use `$.audio.play({ url })` for ElevenLabs.** The engine fetches the URL itself, and you can't attach the `xi-api-key` header.
- **Binary uploads** (speech-to-text, voice cloning: multipart) can't go through `$.http.fetch`. The fallback is `$.process.run(['curl', ...])`, which is CLI only and shows up as a `process` call in validate output. Prefer to avoid it.
- **Playback** goes through `afplay` on macOS. A Linux or Windows terminal plays nothing, and `$.audio.play` resolves anyway. Clips don't queue: two `play` calls overlap. Chain the promises yourself to serialize speech, and pass `signal` (an AbortController's) to stop a clip, e.g. when the user submits a new prompt.
- `$.audio.speak(text)` is the OS synthesizer (`say`), which is free and offline. Use it as a fallback when there's no API key or the request fails.

## API key

```json
"userConfig": {
  "api_key":  { "type": "string", "title": "ElevenLabs API key", "description": "...", "sensitive": true },
  "voice_id": { "type": "string", "title": "Voice ID", "description": "...", "default": "JBFqnCBsd6RMkjVDRZzb" }
}
```

- `sensitive: true` masks the input and keeps the key in secure storage, not `settings.json`. Values arrive as `register(on, options)`'s `options`.
- Don't mark it `required`, because a required field with no value fails the whole load. Fall back to `await $.env.get('ELEVENLABS_API_KEY')` (string literal, so validate lists it under `env reads:`). That fallback is also the easy path while developing with `--plugin-dir`.
- Never put the key in `$.ui.log`/`toast`/`status`, error text, or `$.store`.

## What to speak

- **`turn.complete`**: `e.answer` is the assistant's final visible text ('' when there is none). Skip when `e.agentId` is set (a subagent's turn), when `e.isAborted`, or when `e.reason !== 'answer'`. Always `return next(e)`.
- Strip markdown, code fences, file paths and URLs before sending, and cap the length. ElevenLabs bills per character, and a long answer read aloud is noise. Better patterns: speak a summary (`$.model.complete({ model, prompt })` yields a one-sentence version), or just the first paragraph.
- `prompt.submit`: a good place to abort the clip that's still playing.
- `tool.call` / `turn.start`: short cues ("running tests"). Pre-render fixed phrases once and cache them (base64 in `$.store`, or a file the mod ships played with `{ asset }`), so a cue costs no request.

## Not settled yet: verify before relying on it

- Whether awaiting a long `$.audio.play` inside `turn.complete` delays the next prompt. A hook's time budget excludes in-flight `$` calls, but the turn may still wait. If it does, push the text onto a queue and drain it from a `$.clock.after(0, ...)` timer started outside the dispatch. The `plugin-authoring` reference's "Work that outlives a dispatch" section describes the pattern.
- `audio.speak` is itself a hookable event. A mod could answer it so that every mod's `$.audio.speak` uses an ElevenLabs voice. Check the result shape in the types and write a test before building on this.

## Request defaults

- Header `xi-api-key: <key>`, `content-type: application/json`.
- Body `{ text, model_id }`. `eleven_flash_v2_5` is low-latency and cheap, good for interactive cues; `eleven_multilingual_v2` is the API default and higher quality. Optional: `voice_settings: { stability, similarity_boost, style, speed, use_speaker_boost }`, `language_code`, and `previous_text`/`next_text` for continuity across chunks.
- Query `output_format=mp3_44100_128` (the default; `mp3_22050_32` makes smaller payloads).
- On `!res.ok`: the body is JSON with a `detail`. Show the status code and a short reason; never the request.

## Testing it

Stub the network and the speaker beneath the plugin. Stubs answer `{ value }`:

```ts
mock.env(on, { ELEVENLABS_API_KEY: 'test-key' })
on('http.fetch', (_$, e) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ audio_base64: 'QUJD' }) } }))
on('audio.play', (_$, e) => ({ value: undefined }))   // e.clip.base64, e.clip.mime
```

Also cover the failure paths: no key (expect the hint text), `ok: false` (expect a readable error and no `audio.play`).
