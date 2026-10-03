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

## 🎬 See it in action

One real 20-minute session, in which WolfBud was used to build WolfBud's own Orca support. Every change was asked for out loud, and the session pushed three commits.

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/call-sends-to-claude.jpg" alt="The WolfBud window says it sent the request; the terminal shows the prompt it wrote for Claude"></td>
    <td width="50%"><img src="assets/screenshots/queued-while-claude-works.jpg" alt="While Claude works, WolfBud queues a follow-up request about the README"></td>
  </tr>
  <tr>
    <td><b>You talk, it sends.</b> If something is unclear it asks first, then it writes the prompt and hands it to Claude.</td>
    <td><b>Keep talking while Claude works.</b> New requests are queued for when Claude is done.</td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/speaks-up-when-done.jpg" alt="WolfBud tells you Claude is done and what changed"></td>
    <td width="50%"><img src="assets/screenshots/inside-orca.jpg" alt="WolfBud in Orca's built-in browser, split beside the Claude Code session"></td>
  </tr>
  <tr>
    <td><b>It speaks up when Claude is done</b>, with what changed and what is still untested.</td>
    <td><b>Inside Orca.</b> The last call of the session ran in Orca's built-in browser, the feature it had just built.</td>
  </tr>
</table>

The demo videos of that session (a story cut, a narrated "how it works" and a vertical teaser) come from [`video/`](video), a Remotion project.

## 🐺 What it does

- 👀 **Watches the session.** Your prompts, Claude's tool calls, failures, final answers and permission prompts all reach the agent as context.
- 🎙️ **Talks with you.** A call with an ElevenLabs conversational agent, shown as a 3D wolf whose jaw follows its voice and whose head turns to look at your pointer.
- 📨 **Sends prompts to Claude.** When you decide something together, `wolfbud_send_to_claude` starts a turn, adds a note to the running one, or queues it for when Claude is done.
- 🔔 **Speaks up when Claude finishes** or is waiting on a permission, after a pause so it doesn't talk over you.
- 🛑 **Stops Claude** if you ask it to.

<p align="center">
  <img src="assets/screenshots/how-it-works.jpg" alt="How WolfBud works: Claude Code's hooks feed the wolfbud mod, which streams events to a local bridge on 127.0.0.1; the bridge talks to the WolfBud window over SSE, and the window holds the WebRTC call with the ElevenLabs voice agent. wolfbud_send_to_claude brings prompts back into Claude's chat. The API key stays in the bridge; the window only gets a per-call token." width="100%">
</p>

The mod itself is in [`mods/wolfbud`](mods/wolfbud); its [README](mods/wolfbud/README.md) has the full architecture, commands and options.

> 🪐 **Optimized for [Orca](https://orca.build).** Run Claude Code in an Orca terminal and WolfBud opens its window as a tab in Orca's built-in browser (the default `browser: auto` picks it inside Orca). Orca needs mic access allowed; see [In Orca](mods/wolfbud/README.md#in-orca-orca-browser) for the setup. Outside Orca, or if that fails, it opens a Chrome app window.

## 🚀 Quick start

You need Claude Code ≥ 2.1.287, Node, [pnpm](https://pnpm.io), Google Chrome (macOS tested) and an [ElevenLabs API key](https://elevenlabs.io/app/settings/api-keys) exported as `ELEVENLABS_API_KEY`.

One command, after cloning (it runs every step below and prints what it does; safe to run again):

```bash
git clone https://github.com/leopiney/wolfbud-claude-mod
cd wolfbud-claude-mod
pnpm run install-plugin       # add --skip-agent to leave your ElevenLabs agent alone, --dry-run to just list the steps
```

Or step by step:

```bash
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
| [`video/`](video) | the demo videos: a Remotion project that cuts them from a session recording, with ElevenLabs music, effects and narration |
| [`assets/`](assets) | the banner, icon and screenshots above |

## 🔗 Related

**[leopiney/wolfbud](https://github.com/leopiney/wolfbud)**: the desktop app this wolf comes from. Text-to-speech and speech-to-text with the ElevenLabs **Scribe v2** model, and really nice. This repo brings the same wolf into Claude Code as a voice coworker.

<p align="center">
  <img src="assets/icon.png" alt="WolfBud icon" width="96">
</p>
