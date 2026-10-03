// Pushes the WolfBud agent definition to ElevenLabs by hand. The bridge does
// the same before a call whenever the definition changed (bridge/agent.mjs),
// so this is for checking a change without a call.
//
//   ELEVENLABS_API_KEY=… pnpm agent:sync            # sync, print the agent id
//   pnpm agent:sync --dry-run                       # check the definition, print what a sync sends
//
// The pre-commit hook runs the dry run whenever the definition changes, since
// every user's bridge pushes it to their own account.

import { loadDefinition, syncAgent, syncPlan } from '../mods/wolfbud/bridge/agent.mjs'

const isDryRun = process.argv.includes('--dry-run')
const definition = loadDefinition()

// The LLM mimics its prompt's punctuation, and an em dash read aloud sounds off.
for (const [where, text] of [
  ['prompt', definition.prompt],
  ['firstMessage', definition.def.firstMessage],
]) {
  if (text.includes('—')) {
    console.error(`${where} contains an em dash; the agent would copy it`)
    process.exit(1)
  }
}

if (isDryRun) {
  console.log(JSON.stringify(syncPlan(definition), null, 2))
  process.exit(0)
}

const apiKey = process.env.ELEVENLABS_API_KEY
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set.')
  process.exit(1)
}

console.log(`Syncing "${definition.def.name}"`)
try {
  const agentId = await syncAgent(apiKey, definition, { log: line => console.log(`  ${line}`) })
  console.log(`  synced ${agentId}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
