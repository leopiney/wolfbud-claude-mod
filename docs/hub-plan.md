# WolfBud hub

2026-10-06

One floating Chrome window. `/wolfbud` subscribes the current Claude session to it. Many Claude sessions can run under that one voice at the same time.

## What stays in Claude

Claude only lets a mod inside that session see the work and put a prompt back. `prompt.submit`, `session.append`, and `turn.abort` in `mods/wolfbud/hooks/register.tsx` have no equivalent from outside. The window cannot grow those hands.

Today each session spawns its own `bridge/server.mjs`. Claude kills that child on unload, and the server also exits when its parent dies. A second session finds port 4747 taken and opens another bridge, another window, and another call. A send from the window is written to that bridge's stdout, and only the mod that spawned it runs `deliver()`. Pointing a second session at the first bridge cannot land a prompt in the second session.

So the mod stays. It becomes a subscriber. The bridge becomes one service that outlives any session. The window stays the face.

```text
Chrome window   the face: roster, wolf, one call
hub             the switchboard: roster, inboxes, tokens
Claude mod      the hands: hooks and deliver() for that session only
```

## One service, one window

The service is `bridge/server.mjs` on a fixed `127.0.0.1:4747`, serving the window you already have. It is not a child of any Claude session. The mic grant is per origin, so the port does not walk the way 4747 does today.

Drop Orca and terminal-browser as places to open the wolf. One Google Chrome app window is the only face: its own profile at `~/.wolfbud/chrome`, `--app` pointed at the hub, and `--autoplay-policy=no-user-gesture-required` so a call can start without a click. That is a separate Chrome from the user's normal one. `open -n` on every `/wolfbud` would start another instance, so the hub opens it once. Later subscriptions only raise it.

The parent-pid exit in `server.mjs` has to go in this mode, or the service dies when the launcher exits. Do not start it with `$.process.spawn`. Claude kills those children.

The first `/wolfbud` that finds the service down starts it and waits for `/api/health`. A short launcher the mod runs and then forgets spawns `node server.mjs` with `detached: true` (a new session) and exits. The launcher writes `~/.wolfbud/hub.json` (port, pid, a token the mods read). The window URL gets a separate key. A session token is not the key that can enqueue commands for every session.

## Subscribe on `/wolfbud`

`/wolfbud` is a subscription, not a new wolf.

1. Reuse the session id in `$.state`, or mint one. A reload must keep it.
2. `POST /api/subscribe` with project, cwd, and capabilities (`submit`, `steer`, `abort`, `snapshot`). The hub adds a row and a short name (`auth`, `auth-2`).
3. Start a `$.clock` loop that long-polls that session's inbox, and keep posting the events the hooks already report.
4. Ask the hub to show the window. The hub runs `open -na Google Chrome` only when no window is connected.

`/wolfbud call` focuses this subscription and starts the one call if it is not already live. `/wolfbud end` hangs up that one call. It does not drop the other subscriptions. `/wolfbud stop` unsubscribes this session only. `session.end` does the same. Another Claude's wolf stays up.

If the service is down, the session keeps working and the pane says so.

## Two directions

The hub never calls Claude. It talks only to the mod already inside a session. The session id is a routing key. The injection still happens in `deliver()`, which already exists.

```text
session A                         hub                         window / voice
    |                              |                              |
    |  subscribe(sessionId)        |                              |
    |----------------------------->|  roster                      |
    |                              |----------------------------->|
    |  events, snapshot            |                              |
    |----------------------------->|  SSE                         |
    |                              |----------------------------->|
    |                              |  "tell auth to add a test"   |
    |                              |<-----------------------------|
    |  poll: send cmd_18           |                              |
    |<-----------------------------|                              |
    |  $.prompt.submit / append    |                              |
    |  ack cmd_18                  |                              |
    |----------------------------->|  tool result                 |
    |                              |----------------------------->|
```

### Up: the session tells the hub

After subscribe, the hooks that already call `report()` post the same `ClaudeEvent`s, plus `sessionId`. A snapshot is the same post, from `$.session.messages()`, when the hub asks for one. `session.end` sends bye, and the hub drops the row.

The window does not talk to a session. It subscribes to the hub over SSE, as it subscribes to the bridge today.

### Down: the hub tells one session

The mod cannot listen. It has `$.http.fetch`, not a socket. The poll is:

```text
GET /sessions/<id>/commands
```

The hub keeps one queue per session id. A command sits there until the matching adapter pulls it. A webpage that guesses an id gets nothing: the pull needs the token from subscribe.

The voice agent does not invent a session id. The hub shows the short names. "Tell auth to add a test" resolves to that row and enqueues:

```json
{ "id": "cmd_18", "type": "send", "prompt": "Add a test for …", "when": "after_current" }
```

`when` is the choice WolfBud already makes. The mod runs it with the same calls `deliver()` uses now:

| Command | What the mod calls |
|---|---|
| send, Claude idle | `$.prompt.submit`. Starts a turn. |
| send, busy, `after_current` | `$.prompt.submit`. Claude queues it until the turn ends. |
| send, busy, `now` | `$.session.append`. A user note the running turn reads at its next step. If Claude refuses, fall back to submit, as today. |
| stop | `$.turn.abort({ turnId })`, using the turn id the hooks already store. |
| snapshot | `$.session.messages()`, posted back. No model turn. |

Then the mod posts the ack for `cmd_18`. The voice tool waits on that ack, the way the bridge's pending map waits today. The tool result is "Sent: Claude is starting on it now" or the failure, not a guess.

## One voice, many Claudes

Every subscribed Claude keeps working. The one voice can send to any of them, including several in one conversation, and each `deliver()` runs in the matching session. A second session that needs you becomes a badge, or a `[session event]` on the call already live.

That is not a second floating wolf, and not a second ElevenLabs call, per Claude. Two calls in one window talk over each other.

The agent definition stays one agent in the user's account. The tools take a short session name and default to the focused session. `wolfbud_send_to_claude` can remain that default. The prompt has to stop assuming a single project.

The thing to build is two Claude sessions, one Chrome window, and a prompt that lands in the session you named.
