// The voice call with the WolfBud agent (mods/wolfbud/elevenlabs/agent.json).
//
// Its client tools are the agent's hands: names must match agent.json's. What
// the agent hears about Claude arrives two ways: contextual updates (quiet:
// folded in, never answered, never interrupting) and "[claude event]" user
// messages (the agent says something). An event worth saying goes in as
// context at once, and its message waits in announcements.ts until the agent's
// turn is over, so one event never cuts off the agent mid-reply to another.
// When several wait, the agent says the first, knows the count, and offers the
// rest; it pulls each next one with `wolfbud_next_update`.

import { Conversation } from '@elevenlabs/client'
import type { VoiceConversation } from '@elevenlabs/client'

import type { CallStatus, VoiceMode } from '../../mods/wolfbud/hooks/events'
import type { Bridge } from './bridge'
import { AnnouncementQueue } from './announcements'
import type { Announcement } from './announcements'
import type { ActivityFocus } from './context'

export type CallView = {
  status(status: CallStatus, error?: string): void
  mode(mode: VoiceMode): void
  /** The agent's words: tentative as it starts speaking, then final (or corrected after an interruption). */
  agentLine(text: string, isFinal: boolean): void
  userLine(text: string): void
  userSpeaking(isSpeaking: boolean): void
}

export type CallDeps = {
  bridge: Bridge
  view: CallView
  dynamicVariables(): Record<string, string>
  activity(focus: ActivityFocus, session: string | null): string
  /** The call is up: time to hand the agent its context. */
  connected(): void
}

const VAD_SPEAKING = 0.5
const USER_HOLD_MS = 1500
const PENDING_CONTEXT = 'wolfbud_pending'
const HEARTBEAT_MS = 25_000
const PROMISE =
  /\b(?:one (?:sec|second|moment)|let me (?:send|tell|pass|ask|check|look|pull)|i'?ll (?:send|tell|pass|ask|let claude)|sending (?:that|it)|passing (?:that|it))\b/i
const NUDGE = '[continue] You said you would do something but did not call the tool. Call it now and carry on from its result.'
const JUNK = /^[\s.…·,!?-]*$/
/** Eleven v4's audio tags ("[laughing]") steer the voice; they're not words to show. */
const AUDIO_TAG = /\[[^\]\n]{1,40}\]/g

function shown(text: string): string {
  return text
    .replace(AUDIO_TAG, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export class WolfCall {
  private conversation: VoiceConversation | null = null
  private state: CallStatus = 'idle'
  private voiceMode: VoiceMode = 'listening'
  private isMuted = false
  private lastUserVoiceAt = 0
  private lastMessageAt = 0
  private lastToolAt = 0
  private lastNudgeAt = 0
  private readonly announcements = new AnnouncementQueue()
  private timers: number[] = []
  private watchdog: number | null = null

  constructor(private readonly deps: CallDeps) {}

  get status(): CallStatus {
    return this.state
  }

  get mode(): VoiceMode {
    return this.voiceMode
  }

  get isLive(): boolean {
    return this.state === 'live' && this.conversation !== null
  }

  /** 0..1, for the wolf's jaw. */
  outputLevel(): number {
    return this.isLive ? (this.conversation?.getOutputVolume() ?? 0) : 0
  }

  /** 0..1, for the wolf's listening tilt. */
  inputLevel(): number {
    return this.isLive && !this.isMuted ? (this.conversation?.getInputVolume() ?? 0) : 0
  }

  private setStatus(status: CallStatus, error?: string): void {
    this.state = status
    this.deps.view.status(status, error)
    this.deps.bridge.status(status, status === 'live' ? this.voiceMode : null, error)
  }

  async start(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'live') return
    this.setStatus('connecting')

    // The mic grant has to exist before the WebRTC session is built, or it
    // connects and never hears the user.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
    } catch {
      this.setStatus('error', 'WolfBud needs the microphone: allow it for this window, then call again.')
      return
    }

    let conversationToken: string
    try {
      conversationToken = await this.deps.bridge.token()
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
      return
    }

    try {
      this.conversation = (await Conversation.startSession({
        conversationToken,
        connectionType: 'webrtc',
        dynamicVariables: this.deps.dynamicVariables(),
        clientTools: this.tools(),
        onConnect: () => this.onConnected(),
        onDisconnect: details => {
          const error = details.reason === 'error' ? details.message : undefined
          this.cleanUp()
          this.setStatus(error ? 'error' : 'idle', error)
        },
        onError: message => console.warn('[call]', message),
        onModeChange: ({ mode }) => {
          this.voiceMode = mode
          this.announcements.agentSpeaking(mode === 'speaking', Date.now())
          this.deps.view.mode(mode)
          if (this.state === 'live') this.deps.bridge.status('live', mode)
        },
        onMessage: ({ role, message: raw }) => {
          const message = role === 'agent' ? shown(raw) : raw
          if (JUNK.test(message)) return
          if (role === 'user') {
            this.lastUserVoiceAt = Date.now()
            this.announcements.userSpoke(Date.now())
            this.announcements.replyOwed(Date.now())
            this.clearWatchdog()
            this.deps.view.userLine(message)
            this.deps.bridge.line('user', message)
          } else {
            this.announcements.agentReplied(Date.now())
            this.deps.view.agentLine(message, true)
            this.deps.bridge.line('agent', message)
            this.armWatchdog(message)
          }
        },
        onDebug: (event: { type?: string; response?: string }) => {
          const text = event.type === 'tentative_agent_response' && event.response ? shown(event.response) : ''
          if (text === '' || JUNK.test(text)) return
          this.announcements.agentDrafting(Date.now())
          this.deps.view.agentLine(text, false)
        },
        onAgentResponseCorrection: ({ corrected_agent_response: raw }) => {
          const corrected = shown(raw)
          if (!JUNK.test(corrected)) this.deps.view.agentLine(corrected, true)
        },
        onVadScore: ({ vadScore }) => {
          if (vadScore < VAD_SPEAKING) return
          this.lastUserVoiceAt = Date.now()
          this.announcements.userSpoke(Date.now())
        },
      })) as VoiceConversation
    } catch (error) {
      this.cleanUp()
      this.setStatus('error', `Couldn't start the call: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async end(): Promise<void> {
    const conversation = this.conversation
    if (conversation === null) {
      if (this.state !== 'idle') this.setStatus('idle')
      return
    }
    this.cleanUp()
    await conversation.endSession().catch(() => undefined)
    this.setStatus('idle')
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted
    this.conversation?.setMicMuted(this.isMuted)
    return this.isMuted
  }

  /** Quiet context: the agent folds it in and doesn't answer. With an id, it replaces the last one under that id. */
  context(text: string, contextId?: string): void {
    if (!this.isLive) return
    try {
      this.conversation?.sendContextualUpdate(text, contextId ? { contextId } : undefined)
    } catch (error) {
      console.warn('[call] context update failed', error)
    }
  }

  /**
   * Something the agent should say. `context` goes in now, without cutting off
   * anything, and so does the new count of what is waiting; the message waits
   * its turn. A newer one of the same kind replaces a waiting one.
   */
  announce(item: Omit<Announcement, 'at'>, context: string): void {
    if (!this.isLive) return
    this.context(context)
    this.announcements.push(item, Date.now())
    this.context(this.announcements.pendingNote(), PENDING_CONTEXT)
  }

  private onConnected(): void {
    this.voiceMode = 'speaking'
    this.announcements.agentSpeaking(true, Date.now())
    this.setStatus('live')
    this.lastMessageAt = Date.now()
    this.timers.push(window.setInterval(() => this.drain(), 500))
    this.timers.push(window.setInterval(() => this.heartbeat(), 5000))
    this.deps.connected()
  }

  private isUserSpeaking(): boolean {
    return Date.now() - this.lastUserVoiceAt < USER_HOLD_MS
  }

  /** Once the agent has finished and the user isn't talking: the first waiting event, or the offer of the rest. */
  private drain(): void {
    this.deps.view.userSpeaking(this.isUserSpeaking())
    if (!this.isLive) return
    const now = Date.now()
    const turn = this.announcements.take(now, this.isUserSpeaking())
    if (turn === null) return
    this.lastMessageAt = now
    if (turn.type === 'announce') this.context(this.announcements.pendingNote(), PENDING_CONTEXT)
    this.conversation?.sendUserMessage(turn.text)
  }

  /** Long silences are the norm on this call; activity keeps the agent from checking in. */
  private heartbeat(): void {
    if (!this.isLive || this.voiceMode === 'speaking' || this.isUserSpeaking()) return
    const now = Date.now()
    if (now - this.lastMessageAt < HEARTBEAT_MS) return
    this.lastMessageAt = now
    this.conversation?.sendUserActivity()
  }

  /** "Let me send that to Claude" with no tool call after it freezes a voice agent: nudge it once. */
  private armWatchdog(said: string): void {
    this.clearWatchdog()
    if (!PROMISE.test(said)) return
    const saidAt = Date.now()
    const check = () => {
      if (!this.isLive || this.lastToolAt > saidAt || this.isUserSpeaking()) return
      if (this.voiceMode === 'speaking') {
        this.watchdog = window.setTimeout(check, 2000)
        return
      }
      if (Date.now() - this.lastNudgeAt < 15_000) return
      this.lastNudgeAt = Date.now()
      this.lastMessageAt = Date.now()
      this.announcements.replyOwed(Date.now())
      this.conversation?.sendUserMessage(NUDGE)
    }
    this.watchdog = window.setTimeout(check, 5000)
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) window.clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private cleanUp(): void {
    for (const timer of this.timers) window.clearInterval(timer)
    this.timers = []
    this.clearWatchdog()
    this.announcements.clear()
    this.conversation = null
    this.deps.view.userSpeaking(false)
  }

  /** Keys are the tool names in agent.json: the whole contract with the agent. */
  private tools(): Record<string, (parameters: Record<string, unknown>) => Promise<string> | string> {
    // A tool call means the agent answers its result next: hold the queue for that.
    const touch = () => {
      this.lastToolAt = Date.now()
      this.announcements.replyOwed(Date.now())
      this.clearWatchdog()
    }
    return {
      wolfbud_send_to_claude: async parameters => {
        touch()
        const prompt = String(parameters.prompt ?? '').trim()
        if (prompt === '') return 'No prompt given: say what Claude should do in `prompt`.'
        const session = String(parameters.session ?? '').trim()
        return this.deps.bridge.ask({
          type: 'send',
          prompt,
          when: parameters.when === 'now' ? 'now' : 'after_current',
          summary: String(parameters.summary ?? ''),
          ...(session !== '' ? { session } : {}),
        })
      },
      wolfbud_stop_claude: async parameters => {
        touch()
        const session = String(parameters.session ?? '').trim()
        return this.deps.bridge.ask({
          type: 'stop',
          reason: String(parameters.reason ?? ''),
          ...(session !== '' ? { session } : {}),
        })
      },
      wolfbud_next_update: () => {
        touch()
        const next = this.announcements.next(Date.now())
        this.context(this.announcements.pendingNote(), PENDING_CONTEXT)
        return next ?? 'No updates are waiting.'
      },
      wolfbud_claude_activity: parameters => {
        touch()
        const focus = ['last_answer', 'recent_steps', 'errors', 'overview'].includes(String(parameters.focus))
          ? (String(parameters.focus) as ActivityFocus)
          : 'overview'
        const session = String(parameters.session ?? '').trim()
        return this.deps.activity(focus, session === '' ? null : session)
      },
    }
  }
}
