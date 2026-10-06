/** The shared hub (bridge/server.mjs) and this session's subscription to it. */
export type WolfbudHub = {
  status: 'off' | 'starting' | 'ready' | 'down' | 'error'
  /** Fixed origin: 127.0.0.1:4747. The mic grant is per origin, so it does not walk. */
  port: number
  error: string | null
  hasApiKey: boolean
  isWindowBuilt: boolean
  isWindowOpen: boolean
  /** The person started WolfBud and hasn't stopped it: a reload subscribes again. */
  isWanted: boolean
  /** Stable across a reload. A new session mints another. */
  sessionId: string
  /** Pulls this session's inbox only. Not the key that can enqueue for every session. */
  sessionToken: string
  /** From ~/.wolfbud/hub.json. Subscribes and asks the hub to show the window. */
  serviceToken: string
  /** Short name the voice uses (`auth`, `auth-2`). */
  name: string
}

/** The one voice call, as the window reports it. Shared by every subscription. */
export type WolfbudCall = {
  status: 'idle' | 'connecting' | 'live' | 'error'
  mode: 'speaking' | 'listening' | null
  error: string | null
}

/** A row of the pane's transcript: what was said, and what went to Claude. */
export type WolfbudLine = {
  id: number
  role: 'user' | 'agent' | 'sent' | 'note'
  text: string
}

/** Whether Claude is mid-turn, and that turn's id (for a stop). */
export type WolfbudClaude = {
  isBusy: boolean
  turnId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    wolfbud: {
      hub: WolfbudHub
      call: WolfbudCall
      lines: WolfbudLine[]
      claude: WolfbudClaude
    }
  }
}
