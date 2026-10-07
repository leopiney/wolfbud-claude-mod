// What WolfBud says out loud about Claude, and when.
//
// An event reaches the agent twice. At once, as a contextual update: it knows,
// and nothing it is saying gets cut off. Later, as a "[claude event]" or
// "[session event]" user message that it answers aloud. A user message is a new
// turn and cuts off whatever the agent is in the middle of, so this queue only
// speaks once the agent's turn is over: not speaking, not owing a reply (to the
// user, to the last message, or after a tool call), and quiet for a moment.
//
// Events never pile out in one breath. The oldest one becomes the topic and the
// agent hears how many more are waiting. Once that conversation pauses, the
// agent is asked to offer the rest ("two more things: go through those, or stay
// on this one?"), and from then on the next one comes only when the agent pulls
// it with `wolfbud_next_update`. An offer nobody takes up lapses after a long
// silence, and the next one is announced the plain way again.
//
// Pure and clocked by the caller, so it runs without a browser.

/** After the agent goes quiet, the user gets this long to answer before the app says anything. */
export const AFTER_AGENT_MS = 2500
/** A pause this long in the conversation on a topic is when the rest are offered. */
export const OFFER_AFTER_MS = 5000
/** A topic nobody has talked about for this long is over: the next one is announced, not offered. */
export const TOPIC_IDLE_MS = 20_000
/** An offer nobody took up lapses after this much silence. */
export const OFFER_HOLD_MS = 120_000
/** A reply the agent owes but never gives stops holding the queue after this long. */
export const REPLY_WAIT_MS = 15_000

export type Announcement = {
  /** The "[claude event]" or "[session event]" message the agent answers aloud. */
  text: string
  /** A few words for the waiting list ("shop finished a task"). */
  label: string
  /** A newer one of the same kind replaces a waiting one. */
  kind: string
  at: number
}

/** What the call should send now, if anything. */
export type Turn = { type: 'announce' | 'offer'; text: string }

export class AnnouncementQueue {
  private items: Announcement[] = []
  private isSpeaking = false
  /** The last sign of the agent's turn: its audio starting or stopping, a draft, a line. */
  private agentAt = 0
  private userAt = 0
  /** Set while the agent owes a reply. */
  private owedSince: number | null = null
  /** The announcement being talked about. */
  private topic: Announcement | null = null
  /** When the rest were offered for the current topic. */
  private offeredAt: number | null = null

  get size(): number {
    return this.items.length
  }

  /** A newer one of the same kind (same session, same event) replaces a waiting one and goes to the back. */
  push(item: Omit<Announcement, 'at'>, now: number): void {
    this.items = this.items.filter(waiting => waiting.kind !== item.kind)
    this.items.push({ ...item, at: now })
  }

  /** The agent's audio started or stopped. */
  agentSpeaking(isSpeaking: boolean, now: number): void {
    this.isSpeaking = isSpeaking
    this.agentAt = now
  }

  /** The agent is drafting a reply. */
  agentDrafting(now: number): void {
    this.agentAt = now
  }

  /** The agent finished a line: what it owed is given. */
  agentReplied(now: number): void {
    this.owedSince = null
    this.agentAt = now
  }

  /** The agent has a reply to give: the user spoke, a tool ran, or the app sent it a message. */
  replyOwed(now: number): void {
    this.owedSince = now
  }

  /** The user's voice, heard or transcribed. */
  userSpoke(now: number): void {
    this.userAt = now
  }

  /** Whether the agent's turn is over, so a user message would cut nothing off. */
  isFloorFree(now: number): boolean {
    if (this.isSpeaking) return false
    if (this.owedSince !== null && now - this.owedSince < REPLY_WAIT_MS) return false
    return now - this.agentAt >= AFTER_AGENT_MS
  }

  /**
   * What to say now, if anything: the oldest event when no topic is going, or
   * the offer of the rest once the talk on the current one pauses. Either
   * means a reply is owed.
   */
  take(now: number, isUserSpeaking: boolean): Turn | null {
    if (this.items.length === 0 || isUserSpeaking || !this.isFloorFree(now)) return null
    const quiet = now - Math.max(this.agentAt, this.userAt)
    if (this.offeredAt !== null) {
      if (quiet < OFFER_HOLD_MS) return null
      this.offeredAt = null
      this.topic = null
    }
    if (this.topic !== null && quiet < TOPIC_IDLE_MS) {
      if (quiet < OFFER_AFTER_MS) return null
      this.offeredAt = now
      this.replyOwed(now)
      return { type: 'offer', text: this.offer(this.topic) }
    }
    const next = this.next(now)
    if (next === null) return null
    this.replyOwed(now)
    return { type: 'announce', text: next }
  }

  /** The oldest waiting event, now the topic, with its age and what is still waiting. Null when none is. */
  next(now: number): string | null {
    const item = this.items.shift()
    if (item === undefined) return null
    this.topic = item
    this.offeredAt = null
    const minutes = Math.floor((now - item.at) / 60_000)
    const age = minutes >= 1 ? ` (This happened ${minutes === 1 ? 'a minute' : `${minutes} minutes`} ago.)` : ''
    const rest = this.items.length
    const after =
      rest === 0
        ? ''
        : ` ${count(rest)} waiting after this one. Don't bring ${rest === 1 ? 'it' : 'them'} up yet: the app will tell you when to offer ${rest === 1 ? 'it' : 'them'}.`
    return `${item.text}${age}${after}`
  }

  /** What is waiting, as quiet context the agent keeps current under one id. */
  pendingNote(): string {
    if (this.items.length === 0) return '[claude activity] No updates are waiting to be told.'
    return (
      `[claude activity] ${count(this.items.length)} waiting to be told: ${this.items.map(item => item.label).join('; ')}. ` +
      "Don't read them out on your own. When the user wants the next one, call wolfbud_next_update."
    )
  }

  clear(): void {
    this.items = []
    this.isSpeaking = false
    this.agentAt = 0
    this.userAt = 0
    this.owedSince = null
    this.topic = null
    this.offeredAt = null
  }

  private offer(topic: Announcement): string {
    const rest = this.items.length
    return (
      `[pending updates] ${count(rest)} waiting: ${this.items.map(item => item.label).join('; ')}. ` +
      `Ask the user in one short sentence whether to go through ${rest === 1 ? 'it' : 'them'} now or stay on ${topic.label} first. ` +
      `Don't read ${rest === 1 ? 'it' : 'them'} out yet. If they want ${rest === 1 ? 'it' : 'them'}, call wolfbud_next_update.`
    )
  }
}

function count(n: number): string {
  return n === 1 ? 'One more update is' : `${n} more updates are`
}
