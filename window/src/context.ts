// How Claude's activity reads to the voice agent (the "[claude activity]" and
// "[claude event]" messages its prompt describes), to the activity tool, and
// to the feed under the wolf.

import type { ClaudeEvent } from '../../mods/wolfbud/hooks/events'

type ToolEvent = Extract<ClaudeEvent, { kind: 'tool' }>
type TurnComplete = Extract<ClaudeEvent, { kind: 'turn-complete' }>
type PromptEvent = Extract<ClaudeEvent, { kind: 'prompt' }>

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`
}

export function stepLine(event: ToolEvent): string {
  const what = `${event.isSubagent ? 'a subagent ran ' : ''}${event.tool}${event.detail ? ` (${event.detail})` : ''}`
  if (event.status === 'denied') return `${what}: blocked${event.error ? `, ${clip(event.error, 160)}` : ''}`
  if (event.status === 'error') return `${what}: failed${event.error ? `, ${clip(event.error, 220)}` : ''}`
  return what
}

/** Everything since the latest turn started, or the whole list when none has. */
function currentTurn(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  const start = events.findLastIndex(event => event.kind === 'turn-start')
  return start === -1 ? [...events] : events.slice(start)
}

function lastPrompt(events: readonly ClaudeEvent[]): PromptEvent | undefined {
  return events.findLast((event): event is PromptEvent => event.kind === 'prompt')
}

function lastAnswer(events: readonly ClaudeEvent[]): TurnComplete | undefined {
  return events.findLast((event): event is TurnComplete => event.kind === 'turn-complete')
}

/**
 * The rolling "[claude activity]" update: what Claude is on and its latest
 * steps. Sent under one context id, so each replaces the last.
 */
export function activityUpdate(events: readonly ClaudeEvent[], isBusy: boolean): string {
  const turn = currentTurn(events)
  const steps = turn.filter((event): event is ToolEvent => event.kind === 'tool')
  const prompt = lastPrompt(events)
  const failed = steps.filter(step => step.status !== 'ok').length
  const head = isBusy
    ? `[claude activity] Claude is working${prompt ? ` on: "${clip(prompt.text, 300)}"` : ''}. ${steps.length} steps so far${failed ? `, ${failed} failed` : ''}.`
    : `[claude activity] Claude is idle, waiting for the user.`
  if (steps.length === 0) return head
  return `${head} Latest steps, oldest first: ${steps.slice(-8).map(stepLine).join('; ')}.`
}

/** A typed prompt goes into the agent's history as-is (no context id: it shouldn't be replaced). */
export function promptUpdate(event: PromptEvent): string | null {
  if (event.from === 'wolfbud') return null
  return `[claude activity] The user typed a new prompt to Claude in the terminal: "${clip(event.text, 600)}"`
}

/**
 * The same moment, named for a session that is not the one the call is focused
 * on. The agent should mention the short name; it is not the focused project.
 */
export function sessionSpoken(event: ClaudeEvent, name: string): string | null {
  const spoken = spokenEvent(event)
  if (spoken === null) return null
  return spoken.replace('[claude event]', `[session event] ${name}:`)
}

/** The events worth saying out loud, as the "[claude event]" message the agent answers. */
export function spokenEvent(event: ClaudeEvent): string | null {
  if (event.kind === 'turn-complete') {
    const how =
      event.reason === 'answer' ? 'finished its task' : event.reason === 'aborted' ? 'was interrupted' : `stopped (${event.reason})`
    const answer = event.answer.trim() === '' ? 'It left no final message.' : `Its final message: "${clip(event.answer, 900)}"`
    return `[claude event] Claude ${how} after ${seconds(event.durationMs)}. ${answer} Tell the user the gist in one short sentence.`
  }
  if (event.kind === 'notification') {
    if (event.type === 'clear') return null
    if (/permission/i.test(event.type) || /permission/i.test(event.message)) {
      return `[claude event] Claude is waiting for the user's permission: "${clip(event.message, 200)}". Let them know in one short sentence.`
    }
    if (/idle/i.test(event.type)) return null
    return `[claude event] Claude Code says: "${clip(event.message, 200)}". Mention it in one short sentence if it matters.`
  }
  return null
}

/** What `spokenEvent` would say, as quiet context instead (announcements off). */
export function quietEvent(event: ClaudeEvent): string | null {
  if (event.kind === 'notification' && event.type === 'clear') return `[claude activity] ${event.message}`
  const spoken = spokenEvent(event)
  return spoken === null ? null : quietOf(spoken)
}

/** A few words naming a spoken event, for the waiting list ("shop finished a task"). */
export function eventLabel(event: ClaudeEvent, name: string): string {
  if (event.kind === 'turn-complete') {
    return `${name} ${event.reason === 'answer' ? 'finished a task' : event.reason === 'aborted' ? 'was interrupted' : 'stopped'}`
  }
  if (event.kind === 'notification' && (/permission/i.test(event.type) || /permission/i.test(event.message))) {
    return `${name} is waiting for permission`
  }
  return `${name} has a notice`
}

/** A spoken event as quiet context: the same facts, without the instruction to say them. */
export function quietOf(spoken: string): string {
  return spoken.replace(/^\[(?:claude|session) event\]/, '[claude activity]').replace(/ (Tell|Let|Mention) [^.]*\.$/, '')
}

export type ActivityFocus = 'last_answer' | 'recent_steps' | 'errors' | 'overview'

/** The `wolfbud_claude_activity` tool's answer, from what this window has seen. */
export function activityAnswer(focus: ActivityFocus, events: readonly ClaudeEvent[], isBusy: boolean, snapshot: string): string {
  const steps = events.filter((event): event is ToolEvent => event.kind === 'tool')
  switch (focus) {
    case 'last_answer': {
      const answer = lastAnswer(events)
      if (answer) return `Claude's latest final message (${seconds(Date.now() - answer.at)} ago): ${clip(answer.answer, 2500) || '(empty)'}`
      return snapshot !== ''
        ? `No task has finished since the call started. From the session snapshot:\n${snapshot}`
        : 'Claude has not finished a task in this session yet.'
    }
    case 'recent_steps':
      return steps.length === 0
        ? 'Claude has not run any tools yet.'
        : `Claude's latest steps, oldest first:\n${steps.slice(-15).map(stepLine).join('\n')}`
    case 'errors': {
      const failed = steps.filter(step => step.status !== 'ok')
      return failed.length === 0
        ? 'No failed steps recently.'
        : `Recent failed steps, oldest first:\n${failed.slice(-8).map(stepLine).join('\n')}`
    }
    case 'overview': {
      const prompt = lastPrompt(events)
      const answer = lastAnswer(events)
      const turn = currentTurn(events).filter(event => event.kind === 'tool').length
      return [
        isBusy ? `Claude is working (${turn} steps into the current task).` : 'Claude is idle.',
        prompt ? `Latest prompt (${prompt.from === 'wolfbud' ? 'sent by you' : 'typed by the user'}): "${clip(prompt.text, 600)}"` : '',
        answer ? `Latest final message: "${clip(answer.answer, 800)}"` : '',
        snapshot,
      ]
        .filter(Boolean)
        .join('\n')
    }
  }
}

/** The feed under the wolf: one short line per event, or null to skip it. */
export function feedLine(event: ClaudeEvent): { icon: string; text: string; tone: 'ok' | 'bad' | 'info' } | null {
  switch (event.kind) {
    case 'prompt':
      return { icon: event.from === 'wolfbud' ? '🐺' : '›', text: clip(event.text, 90), tone: 'info' }
    case 'turn-start':
      return null
    case 'tool':
      return {
        icon: event.status === 'ok' ? '✓' : '✕',
        text: clip(`${event.tool}${event.detail ? ` · ${event.detail}` : ''}`, 90),
        tone: event.status === 'ok' ? 'ok' : 'bad',
      }
    case 'turn-complete':
      return { icon: '■', text: clip(event.answer || `turn ${event.reason}`, 90), tone: event.reason === 'answer' ? 'info' : 'bad' }
    case 'notification':
      return { icon: '!', text: clip(event.message, 90), tone: 'bad' }
  }
}
