// An agent's terminal UI, for tests: says which chat it shows and at what
// size, again when the size changes, and echoes the lines typed into it.
import { createInterface } from 'node:readline';

const size = () => `${process.stdout.columns}x${process.stdout.rows}`;
process.stdout.write(`tui for ${process.argv[2]} at ${size()}\r\n`);
process.stdout.on('resize', () => process.stdout.write(`resized to ${size()}\r\n`));
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'quit') process.exit(3);
  process.stdout.write(`typed ${line}\r\n`);
});
