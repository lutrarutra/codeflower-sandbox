// Prints each agent's home in the project, one per line, for the entrypoint:
// its variable's value where the app set it, else STATE/<path> from its descriptor.
//   node homes.js STATE
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const state = process.argv[2] ?? '/codeflower-state';
for (const entry of readdirSync(directory, { withFileTypes: true })) {
  const file = join(directory, entry.name, 'agent.json');
  if (!entry.isDirectory() || !existsSync(file)) continue;
  const { home } = JSON.parse(readFileSync(file, 'utf8'));
  if (home) console.log(process.env[home.variable] || join(state, home.path));
}
