#!/usr/bin/env node
// Starts Claude Code's ACP adapter (its entry script is the first argument)
// with steering changed (steer-background.js) and its subagents stoppable one
// by one (stop-subagent.js). The adapter reads its own
// arguments and reruns itself as `node <argv[1]> …` (its terminal sign-in), so
// `process.argv` becomes what it would be without this script: [node, entry, …].
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchSteer } from './steer-background.js';
import { patchSubagentCancel } from './stop-subagent.js';

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('codeflower: no Claude adapter to start\n');
  process.exit(1);
}
process.argv.splice(1, 2, entry);

// The module the adapter's entry loads too, so the class it uses is this one.
try {
  const { ClaudeAcpAgent } = await import(pathToFileURL(join(dirname(entry), 'v1', 'acp-agent.js')).href);
  patchSteer(ClaudeAcpAgent);
  patchSubagentCancel(ClaudeAcpAgent);
} catch (error) {
  process.stderr.write(`codeflower: Claude adapter unchanged: ${error?.message ?? error}\n`);
}
await import(pathToFileURL(entry).href);
