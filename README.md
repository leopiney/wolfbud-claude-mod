<p align="center">
  <img src="assets/banner.png" alt="WolfBud: a voice coworker beside your Claude Code session" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Claude_Code-mod-d97757?logo=claude&logoColor=white" alt="Claude Code mod">
  <img src="https://img.shields.io/badge/ElevenLabs-voice_agent-111111?logo=elevenlabs&logoColor=white" alt="ElevenLabs voice agent">
  <img src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/three.js-3D_wolf-000000?logo=threedotjs&logoColor=white" alt="three.js">
  <img src="https://img.shields.io/badge/Vite-window-646cff?logo=vite&logoColor=white" alt="Vite">
</p>

<p align="center">
  <b>WolfBud</b> is a voice coworker that sits beside your Claude Code session.<br>
  You talk things through with it. When you agree on something, it sends the prompt to Claude for you.
</p>

> [!NOTE]
> **Not affiliated with ElevenLabs.** This is an independent, unofficial project. It just calls the public [ElevenLabs API](https://elevenlabs.io/docs) with your own API key. "ElevenLabs" and its logo belong to ElevenLabs.

## 🐺 What it does

- 👀 **Watches the session.** Your prompts, Claude's tool calls, failures, final answers and permission prompts all reach the agent as context.
- 🎙️ **Talks with you.** A call with an ElevenLabs conversational agent, shown as a 3D wolf whose jaw follows its voice and whose head turns to look at your pointer.
- 📨 **Sends prompts to Claude.** When you decide something together, `wolfbud_send_to_claude` starts a turn, adds a note to the running one, or queues it for when Claude is done.
- 🔔 **Speaks up when Claude finishes** or is waiting on a permission, after a pause so it doesn't talk over you.
- 🛑 **Stops Claude** if you ask it to.

The mod itself is in [`mods/wolfbud`](mods/wolfbud); its [README](mods/wolfbud/README.md) has the full architecture, commands and options.

## 🚀 Quick start

You need Claude Code ≥ 2.1.287, Node, [pnpm](https://pnpm.io), Google Chrome (macOS tested) and an [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys) exported as `ELEVENLABS_API_KEY`.

```bash
git clone https://github.com/leopiney/wolfbud-claude-mod
cd wolfbud-claude-mod
pnpm install
pnpm window:build                          # the call window, served by the mod's local bridge
pnpm agent:sync                            # creates the voice agent in your ElevenLabs account

claude plugin marketplace add "$(pwd)"     # needs an absolute path, "." fails
claude plugin install wolfbud@elevenlabs-mods
printf '{"api_key":"%s"}' "$ELEVENLABS_API_KEY" | claude plugin configure wolfbud@elevenlabs-mods --values-stdin
```

Restart Claude Code, then:

| | |
| --- | --- |
| `/wolfbud` | open the pane and the wolf window |
| `/wolfbud call` | open them and start the call |
| `/wolfbud end` | hang up |

Try it from the repo without installing: `claude --plugin-dir ./mods/wolfbud`.

## 🔐 Your key, your agent

- The agent is created in **your** ElevenLabs account and the calls are billed to it.
- The API key stays in the local bridge (127.0.0.1 only); it never reaches the browser window.
- The bridge checks a per-session key and rejects foreign `Host` and `Origin` headers, so a web page can't push prompts into Claude's chat.

## 🧰 Repo layout

| Path | |
| --- | --- |
| [`mods/wolfbud`](mods/wolfbud) | the Claude Code mod: hooks, pane, local bridge, agent definition |
| [`window/`](window) | the call window: Vite + three.js wolf + `@elevenlabs/client` (WebRTC) |
| [`scripts/`](scripts) | `agent:sync` (create or update the agent from code) and `agent:simulate` (a call without a mic) |
| [`assets/`](assets) | the banner and icon above |

## 🔗 Related

**[leopiney/wolfbud](https://github.com/leopiney/wolfbud)**: the desktop app this wolf comes from. Text-to-speech and speech-to-text with the ElevenLabs **Scribe v2** model, and really nice. This repo brings the same wolf into Claude Code as a voice coworker.

<p align="center">
  <img src="assets/icon.png" alt="WolfBud icon" width="96">
</p>
