// The window's side of mods/wolfbud/bridge/server.mjs: Claude's activity in
// over SSE, the call's state and the agent's requests out over POST.

import type { CallStatus, ClaudeEvent, RosterRow, VoiceMode, WindowCommand } from '../../mods/wolfbud/hooks/events'

export type RosterPayload = { focusedId: string | null; rows: RosterRow[] }

/** The roster plus what each row has seen so far, on connect. */
export type Hello = { focusedId: string | null; rows: Array<RosterRow & { recent: ClaudeEvent[]; snapshot: string }> }

export type SessionEvent = { sessionId: string; event: ClaudeEvent }

export type BridgeHandlers = {
  hello(hello: Hello): void
  roster(roster: RosterPayload): void
  claude(message: SessionEvent): void
  snapshot(message: { sessionId: string; text: string }): void
  command(cmd: WindowCommand): void
  connection(isConnected: boolean): void
}

/** The window key, from `#k=…`. */
export function readKey(): string {
  return new URLSearchParams(location.hash.slice(1)).get('k') ?? ''
}

export class Bridge {
  private source: EventSource | null = null

  constructor(
    private readonly key: string,
    private readonly handlers: BridgeHandlers,
  ) {}

  connect(): void {
    // EventSource can't set headers, so the stream takes the key as ?k=.
    const source = new EventSource(`/api/stream?k=${encodeURIComponent(this.key)}`)
    this.source = source
    const on = <T>(event: string, fn: (data: T) => void) =>
      source.addEventListener(event, message => fn(JSON.parse((message as MessageEvent<string>).data) as T))

    on<Hello>('hello', hello => {
      this.handlers.connection(true)
      this.handlers.hello(hello)
    })
    on<RosterPayload>('roster', roster => this.handlers.roster(roster))
    on<SessionEvent>('claude', message => this.handlers.claude(message))
    on<{ sessionId: string; text: string }>('snapshot', message => this.handlers.snapshot(message))
    on<{ cmd: WindowCommand }>('command', ({ cmd }) => this.handlers.command(cmd))
    // EventSource retries on its own; this only reports the gap.
    source.addEventListener('error', () => this.handlers.connection(false))
  }

  close(): void {
    this.source?.close()
    this.source = null
  }

  private async post(body: object): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await fetch('/api/page', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wolfbud-key': this.key },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    return { status: res.status, data }
  }

  /** Fire-and-forget: a lost status or line isn't worth an error. */
  private tell(body: object): void {
    void this.post(body).catch(() => undefined)
  }

  status(call: CallStatus, mode: VoiceMode | null, error?: string): void {
    this.tell({ type: 'status', call, mode, error })
  }

  line(role: 'user' | 'agent', text: string): void {
    this.tell({ type: 'line', role, text })
  }

  requestSnapshot(): void {
    this.tell({ type: 'snapshot' })
  }

  /** A conversation token for the agent, minted by the hub with the API key it holds. */
  async token(): Promise<string> {
    const res = await fetch('/api/token', { headers: { 'x-wolfbud-key': this.key } })
    const data = (await res.json().catch(() => ({}))) as { token?: string; message?: string }
    if (!res.ok || !data.token) throw new Error(data.message ?? `the hub answered ${res.status}`)
    return data.token
  }

  /** Points the one call at a subscribed session, by the short name the roster shows. */
  focus(session: string): void {
    this.tell({ type: 'focus', session })
  }

  /** The agent's tool calls that act on Claude: resolve to the line the agent reads back. */
  async ask(
    body:
      | { type: 'send'; prompt: string; when: string; summary: string; session?: string }
      | { type: 'stop'; reason: string; session?: string },
  ): Promise<string> {
    try {
      const { data } = await this.post(body)
      return typeof data.message === 'string' && data.message !== '' ? data.message : 'Claude Code did not say what happened.'
    } catch {
      return 'Lost the connection to Claude Code for a moment. Try again in a few seconds.'
    }
  }
}
