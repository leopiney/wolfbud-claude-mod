// The WolfBud window: one wolf, one call, and a roster of Claude sessions.
// The hub opens it at http://127.0.0.1:4747/#k=<window key>.

import './style.css'

import type { ClaudeEvent, RosterRow } from '../../mods/wolfbud/hooks/events'
import { Bridge, readKey } from './bridge'
import type { Hello, RosterPayload, SessionEvent } from './bridge'
import { WolfCall } from './call'
import { activityAnswer, activityUpdate, feedLine, promptUpdate, quietEvent, sessionSpoken, spokenEvent } from './context'
import { createWolf } from './wolf'
import type { Wolf } from './wolf'

const RECENT_LIMIT = 150
const LOST_BRIDGE_MS = 20_000
const ANNOUNCE_KEY = 'wolfbud.announce'
const BADGE_MAX = 236
const BADGE_MIN = 64
const RING_OUTSET = 7

/** A roster row plus what this window has seen of it. The hub owns `isBusy` and `badge`. */
type Tracked = RosterRow & { events: ClaudeEvent[]; snapshot: string; busySince: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const app = $('app')
const stage = $('stage')
const statusText = $('status')
const claudeText = $('claude-status')
const agentCaption = $('caption-agent')
const userCaption = $('caption-user')
const feed = $('feed')
const rosterNav = $('roster')
const callButton = $<HTMLButtonElement>('call')
const muteButton = $<HTMLButtonElement>('mute')
const announceBox = $<HTMLInputElement>('announce')
const overlay = $('overlay')
const overlayText = $('overlay-text')

$('version').textContent = `v${__APP_VERSION__}`

const sessions = new Map<string, Tracked>()
let focusedId: string | null = null
let wolf: Wolf | null = null
let lostAt: number | null = null
let activityTimer: number | null = null
let badgeSize = BADGE_MAX

function readAnnounce(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) !== 'off'
  } catch {
    return true
  }
}

announceBox.checked = readAnnounce()
announceBox.addEventListener('change', () => {
  try {
    localStorage.setItem(ANNOUNCE_KEY, announceBox.checked ? 'on' : 'off')
  } catch {}
})

function showOverlay(text: string | null): void {
  overlay.hidden = text === null
  overlayText.textContent = text ?? ''
}

function focused(): Tracked | null {
  return focusedId === null ? null : (sessions.get(focusedId) ?? null)
}

function named(name: string | null): Tracked | null {
  if (name === null || name === '') return focused()
  const wanted = name.toLowerCase()
  return [...sessions.values()].find(row => row.name.toLowerCase() === wanted) ?? null
}

/**
 * The roster as the hub sends it: rows come and go, busy and badge are the
 * hub's word. A change of focus briefs the agent on the new session.
 */
function applyRoster(payload: RosterPayload): void {
  const seen = new Set<string>()
  for (const row of payload.rows) {
    seen.add(row.id)
    const current = sessions.get(row.id)
    const becameBusy = row.isBusy && current?.isBusy !== true
    sessions.set(row.id, {
      ...row,
      events: current?.events ?? [],
      snapshot: current?.snapshot ?? '',
      busySince: becameBusy ? Date.now() : row.isBusy ? (current?.busySince ?? Date.now()) : 0,
    })
  }
  for (const id of [...sessions.keys()]) if (!seen.has(id)) sessions.delete(id)
  const refocused = payload.focusedId !== focusedId
  focusedId = payload.focusedId
  renderRoster()
  renderClaudeChip()
  if (refocused) {
    renderFeed()
    briefAgent(true)
  }
}

/** Hands the agent the roster and the focused session's activity (and its snapshot, on a change of focus). */
function briefAgent(withSnapshot: boolean): void {
  if (!call.isLive) return
  call.context(rosterUpdate(), 'wolfbud_roster')
  const row = focused()
  if (!row) return
  call.context(activityUpdate(row.events, row.isBusy), 'claude_activity')
  if (withSnapshot && row.snapshot !== '') call.context(row.snapshot, 'session_snapshot')
}

function renderRoster(): void {
  const rows = [...sessions.values()]
  rosterNav.hidden = rows.length === 0
  rosterNav.replaceChildren(
    ...rows.map(row => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'roster-chip'
      if (row.id === focusedId) button.classList.add('focused')
      if (row.isBusy) button.classList.add('busy')
      button.textContent = row.name
      if (row.badge > 0) {
        const badge = document.createElement('span')
        badge.className = 'roster-badge'
        badge.textContent = String(row.badge)
        button.append(badge)
      }
      button.addEventListener('click', () => bridge.focus(row.name))
      return button
    }),
  )
}

const key = readKey()
if (key === '') {
  showOverlay('Open WolfBud from Claude Code: type /wolfbud in a session that loads the wolfbud mod.')
  throw new Error('no window key in the URL')
}

const bridge = new Bridge(key, {
  hello(hello: Hello) {
    sessions.clear()
    applyRoster(hello)
    for (const row of hello.rows) {
      const tracked = sessions.get(row.id)
      if (tracked) {
        tracked.events = row.recent
        tracked.snapshot = row.snapshot
      }
    }
    renderFeed()
  },
  roster(payload) {
    applyRoster(payload)
  },
  claude(message) {
    ingest(message)
  },
  snapshot(message) {
    const row = sessions.get(message.sessionId)
    if (!row) return
    row.snapshot = message.text
    if (row.id === focusedId) call.context(message.text, 'session_snapshot')
  },
  command(cmd) {
    if (cmd === 'start-call') void call.start()
    if (cmd === 'end-call') void call.end()
    if (cmd === 'raise') window.focus()
    if (cmd === 'superseded') {
      void call.end()
      bridge.close()
      showOverlay('WolfBud moved to a newer window. You can close this one.')
      window.setTimeout(() => window.close(), 300)
    }
  },
  connection(isConnected) {
    if (isConnected) {
      lostAt = null
      showOverlay(null)
      bridge.status(call.status, call.isLive ? call.mode : null)
      return
    }
    lostAt ??= Date.now()
    showOverlay('Lost the WolfBud hub. Reconnecting…')
  },
})

const call = new WolfCall({
  bridge,
  dynamicVariables: () => ({
    project_name: focused()?.project ?? 'the current project',
    focused_session: focused()?.name ?? 'none',
    session_names: [...sessions.values()].map(row => row.name).join(', ') || 'none',
  }),
  activity: (focus, session) => {
    const row = named(session)
    if (!row) {
      const names = [...sessions.values()].map(item => item.name).join(', ') || 'none'
      return session ? `No Claude session named ${session}. Subscribed: ${names}.` : 'No Claude session is subscribed.'
    }
    return `Session ${row.name} (${row.project}).\n${activityAnswer(focus, row.events, row.isBusy, row.snapshot)}`
  },
  connected() {
    briefAgent(false)
    bridge.requestSnapshot()
  },
  view: {
    status(status, error) {
      app.dataset.call = status
      callButton.textContent = status === 'live' || status === 'connecting' ? 'End call' : 'Call WolfBud'
      callButton.classList.toggle('primary', status !== 'live' && status !== 'connecting')
      muteButton.disabled = status !== 'live'
      if (status !== 'live') {
        muteButton.classList.remove('muted')
        agentCaption.textContent = ''
        userCaption.textContent = ''
      }
      statusText.textContent =
        status === 'connecting'
          ? 'Calling…'
          : status === 'live'
            ? 'Listening'
            : status === 'error'
              ? (error ?? 'The call failed')
              : 'Not on a call'
      wolf?.mood(status === 'live' ? 'listening' : status === 'connecting' ? 'awake' : 'asleep')
    },
    mode(mode) {
      app.dataset.mode = mode
      if (call.status === 'live') statusText.textContent = mode === 'speaking' ? 'Talking' : 'Listening'
      wolf?.mood(mode === 'speaking' ? 'speaking' : 'listening')
    },
    agentLine(text) {
      agentCaption.textContent = text
    },
    userLine(text) {
      userCaption.textContent = text
    },
    userSpeaking(isSpeaking) {
      app.dataset.hearing = isSpeaking ? 'yes' : 'no'
    },
  },
})

/** One event from any subscribed session. The hub's roster carries the busy state; this keeps the event ring. */
function ingest(message: SessionEvent): void {
  const row = sessions.get(message.sessionId)
  if (!row) return
  row.events.push(message.event)
  row.events.splice(0, Math.max(0, row.events.length - RECENT_LIMIT))
  if (row.id === focusedId) renderFeed()
  tellAgent(row, message.event)
}

function rosterUpdate(): string {
  const rows = [...sessions.values()]
  if (rows.length === 0) return '[claude activity] No Claude session is subscribed.'
  const bits = rows.map(row => `${row.name}${row.id === focusedId ? ' (focused)' : ''}${row.isBusy ? ', working' : ', idle'}`)
  return `[claude activity] Subscribed Claude sessions: ${bits.join('; ')}. Tools default to the focused one. Pass session to reach another.`
}

function renderClaudeChip(): void {
  const row = focused()
  const name = row?.name ?? 'no session'
  app.dataset.claude = row?.isBusy ? 'busy' : 'idle'
  if (!row?.isBusy) {
    claudeText.textContent = `${name} · Claude is idle`
    return
  }
  const s = Math.round((Date.now() - row.busySince) / 1000)
  claudeText.textContent = `${name} · Claude is working · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`
}

function renderFeed(): void {
  const rows = (focused()?.events ?? [])
    .map(feedLine)
    .filter((line): line is NonNullable<typeof line> => line !== null)
    .slice(-5)
  feed.replaceChildren(
    ...rows.map(row => {
      const item = document.createElement('li')
      item.className = `feed-${row.tone}`
      const icon = document.createElement('span')
      icon.className = 'feed-icon'
      icon.textContent = row.icon
      const text = document.createElement('span')
      text.className = 'feed-text'
      text.textContent = row.text
      item.append(icon, text)
      return item
    }),
  )
}

/** Hands the agent each event: spoken when it matters, quiet context otherwise. Another session is a [session event]. */
function tellAgent(row: Tracked, event: ClaudeEvent): void {
  if (!call.isLive) return
  const isFocused = row.id === focusedId
  if (isFocused && event.kind === 'prompt') {
    const update = promptUpdate(event)
    if (update !== null) call.context(update)
  }
  const spoken = isFocused ? spokenEvent(event) : sessionSpoken(event, row.name)
  if (spoken !== null && (announceBox.checked || !isFocused)) {
    call.announce(spoken, `${row.id}:${event.kind}`)
  } else if (isFocused) {
    const quiet = quietEvent(event)
    if (quiet !== null) call.context(quiet)
  }
  if (!isFocused) return
  if (activityTimer !== null) window.clearTimeout(activityTimer)
  activityTimer = window.setTimeout(() => {
    activityTimer = null
    const current = focused()
    if (current) call.context(activityUpdate(current.events, current.isBusy), 'claude_activity')
  }, 2500)
}

callButton.addEventListener('click', () => {
  if (call.status === 'live' || call.status === 'connecting') void call.end()
  else void call.start()
})
muteButton.addEventListener('click', () => {
  const isMuted = call.toggleMute()
  muteButton.classList.toggle('muted', isMuted)
  muteButton.title = isMuted ? 'Unmute' : 'Mute'
})
$('badge').addEventListener('click', () => wolf?.pet())

function fitBadge(): void {
  const gap = parseFloat(getComputedStyle(stage).rowGap) || 0
  const tall = stage.clientHeight - statusText.offsetHeight - gap - 2 * RING_OUTSET
  const wide = stage.clientWidth - 2 * RING_OUTSET
  const size = Math.floor(Math.min(BADGE_MAX, tall, wide))
  app.dataset.wolf = size < BADGE_MIN ? 'hidden' : 'shown'
  if (size < BADGE_MIN || size === badgeSize) return
  badgeSize = size
  app.style.setProperty('--badge', `${size}px`)
  wolf?.resize(size - 16)
}

const fitObserver = new ResizeObserver(fitBadge)
fitObserver.observe(stage)
fitObserver.observe(statusText)
fitObserver.observe(rosterNav)

function animate(): void {
  requestAnimationFrame(animate)
  const isTalking = call.isLive && call.mode === 'speaking'
  wolf?.voice(isTalking, Math.min(1, call.outputLevel() * 2.2))
  wolf?.hear(Math.min(1, call.inputLevel() * 6))
}

window.setInterval(() => {
  if (focused()?.isBusy) renderClaudeChip()
  // The hub is gone, not a single Claude. The call cannot outlive the hub.
  if (lostAt !== null && Date.now() - lostAt > LOST_BRIDGE_MS && call.status !== 'idle') {
    void call.end()
    showOverlay('Lost the WolfBud hub, so the call ended. Reopen it with /wolfbud.')
  }
}, 1000)

window.addEventListener('beforeunload', () => {
  void call.end()
})

void createWolf($('wolf'), './wolf-head.glb', badgeSize - 16).then(created => {
  wolf = created
  wolf?.resize(badgeSize - 16)
  wolf?.mood('asleep')
  animate()
})

bridge.connect()
