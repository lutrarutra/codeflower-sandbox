import { spawn } from 'node:child_process';

const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.exitCode = code ?? (signal ? 128 : 1);
});
