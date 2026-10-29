// Stands in for `claude auth login`: asks for a code and stores a login.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

process.stdout.write('Paste code here if prompted > ');
const input = createInterface({ input: process.stdin });
input.once('line', (code) => {
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ code }));
  process.stdout.write(`\nLogged in with ${code}\n`);
  process.exit(0);
});
