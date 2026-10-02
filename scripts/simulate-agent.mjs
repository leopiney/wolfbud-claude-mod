// Smoke-tests the WolfBud agent with no window and no microphone: a simulated
// user talks it through a change, and the transcript shows whether the agent
// looked up Claude's activity and sent Claude a well-formed prompt.
//
//   ELEVENLABS_API_KEY=… pnpm agent:simulate
//
// Run it after `pnpm agent:sync` when the prompt or the tools change. The
// client tools are mocked here (they only exist in the window).

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../mods/wolfbud/elevenlabs')
const apiKey = process.env.ELEVENLABS_API_KEY
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set.')
  process.exit(1)
}
let agentId
try {
  agentId = JSON.parse(readFileSync(resolve(AGENT_DIR, 'agent-id.json'), 'utf8')).agentId
} catch {
  console.error('No agent-id.json yet: run `pnpm agent:sync` first.')
  process.exit(1)
}

const SIMULATED_USER = `You are Sam, a developer working with Claude Code on a web shop. Right now Claude is adding a dark mode toggle to the settings page, and its last test run failed.
On this voice call with WolfBud, your coworker:
1. Ask how Claude is getting on.
2. Decide out loud that the toggle should remember the choice across reloads using localStorage, and that the settings page tests need updating for it. Ask WolfBud to pass that on to Claude.
3. When WolfBud confirms it was sent, say thanks and goodbye.
Talk like a real person on a call: short, casual, one thing at a time. Never break character.`

const ACTIVITY = 'Claude is working (6 steps into the current task). Latest prompt (typed by the user): "Add a dark mode toggle to the settings page". Latest steps, oldest first: Read (settings/Page.tsx); Edit (settings/Page.tsx); Bash (Run the tests): failed, 3 failed, 12 passed.'

const client = new ElevenLabsClient({ apiKey })
console.log(`Simulating a call with ${agentId}…\n`)
const res = await client.conversationalAi.agents.simulateConversation(agentId, {
  simulationSpecification: {
    simulatedUserConfig: { firstMessage: 'Hey WolfBud.', language: 'en', prompt: { prompt: SIMULATED_USER } },
    dynamicVariables: { project_name: 'shop' },
    // Keyed by tool name: the window answers these for real.
    toolMockConfig: {
      wolfbud_claude_activity: { defaultReturnValue: ACTIVITY },
      wolfbud_send_to_claude: { defaultReturnValue: 'Queued: Claude will start on it as soon as it finishes the current task.' },
      wolfbud_stop_claude: { defaultReturnValue: 'Stopped Claude.' },
    },
  },
})

const sent = []
for (const turn of res.simulatedConversation ?? []) {
  if (turn.message) console.log(`${turn.role === 'agent' ? 'WOLFBUD' : 'USER   '} ▸ ${turn.message}`)
  for (const call of turn.toolCalls ?? []) {
    console.log(`          ⚙ ${call.toolName}(${call.paramsAsJson ?? ''})`)
    if (call.toolName === 'wolfbud_send_to_claude') sent.push(JSON.parse(call.paramsAsJson ?? '{}'))
  }
}

console.log('')
if (sent.length === 0) {
  console.log('✕ The agent never called wolfbud_send_to_claude.')
  process.exit(1)
}
for (const params of sent) {
  const ok = typeof params.prompt === 'string' && params.prompt.length > 20 && ['now', 'after_current'].includes(params.when)
  console.log(`${ok ? '✓' : '✕'} sent (${params.when}): ${params.summary}\n  ${params.prompt}`)
}
