# Verified example: `/say <text>` speaks with ElevenLabs

Checked on Claude Code 2.1.287: `claude plugin validate` passes, `tsc` is clean, and `claude plugin test` passes 1/1. It hasn't been run against the live ElevenLabs API. The endpoint and response shape come from ElevenLabs' API reference (`POST /v1/text-to-speech/{voice_id}/with-timestamps` returns `audio_base64`).

To use it: copy these files into `mods/<name>/`, rename `name` in `plugin.json` (it can't start with `claude-`), and then follow the `mod-dev` loop.

Validate reports:

```
❯ ./register.ts hooks: session.start, command.run{command=say}
❯ ./register.ts calls: $.audio.play (via speak), $.command.register, $.env.get, $.http.fetch (via speak)
❯ ./register.ts env reads: ELEVENLABS_API_KEY
```

## `.claude-plugin/plugin.json`

```json
{
  "name": "voice-smoke",
  "version": "0.1.0",
  "description": "Smoke test: speak text with ElevenLabs from a mod",
  "userConfig": {
    "api_key": {
      "type": "string",
      "title": "ElevenLabs API key",
      "description": "Falls back to the ELEVENLABS_API_KEY environment variable",
      "sensitive": true
    },
    "voice_id": {
      "type": "string",
      "title": "Voice ID",
      "description": "ElevenLabs voice to speak with",
      "default": "JBFqnCBsd6RMkjVDRZzb"
    }
  }
}
```

## `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

## `hooks/register.ts`

```ts
import type { EngineInterface, Register } from 'claude-code'

const API = 'https://api.elevenlabs.io/v1'

type WithTimestamps = { audio_base64: string }

// $.http.fetch hands the body back as text, so a raw MP3 would be mangled:
// the with-timestamps endpoint wraps the audio as base64 in JSON instead.
async function speak($: EngineInterface, apiKey: string, voiceId: string, text: string) {
  const res = await $.http.fetch(
    `${API}/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
    },
  )
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${res.text.slice(0, 200)}`)
  }
  const { audio_base64 } = JSON.parse(res.text) as WithTimestamps
  await $.audio.play({ base64: audio_base64, mime: 'audio/mpeg' })
}

export const register: Register = (on, options) => {
  const voiceId = typeof options.voice_id === 'string' ? options.voice_id : 'JBFqnCBsd6RMkjVDRZzb'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'say', description: 'Speak text with ElevenLabs' })
    return next(e)
  })

  on('command.run', { command: 'say' }, async ($, e) => {
    const apiKey =
      typeof options.api_key === 'string' && options.api_key !== ''
        ? options.api_key
        : await $.env.get('ELEVENLABS_API_KEY')
    if (!apiKey) {
      return { text: 'Set ELEVENLABS_API_KEY or the api_key option first.' }
    }
    await speak($, apiKey, voiceId, e.args)
    return { text: `Spoke ${e.args.length} characters.` }
  })
}
```

## `tests/say.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'

test('/say posts to ElevenLabs and plays the base64 MP3', async ($, on) => {
  let url = ''
  let played = ''
  mock.env(on, { ELEVENLABS_API_KEY: 'test-key' })
  // Hooks beneath the plugin stand for the engine: they answer { value }
  on('http.fetch', (_$, e) => {
    url = e.url
    const text = JSON.stringify({ audio_base64: 'QUJD' })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('audio.play', (_$, e) => {
    played = e.clip.base64 ?? ''
    return { value: undefined }
  })

  const answer = await $.command.run({
    command: 'say',
    args: 'hello',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  expect(answer.text).toBe('Spoke 5 characters.')
  expect(url).toContain('/with-timestamps')
  expect(played).toBe('QUJD')
})
```

