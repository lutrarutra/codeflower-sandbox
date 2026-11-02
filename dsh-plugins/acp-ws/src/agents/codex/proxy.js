#!/usr/bin/env node
// What Codex's ACP adapter runs as `codex` (CODEX_PATH): instead of an
// app-server of its own, the worker's shared one, which Codex's terminal UI
// joins too (`codex --remote`), so both follow the same chats live. The adapter
// speaks JSON lines on stdio; the app-server WebSocket on a Unix socket
// (CODEFLOWER_CODEX_SOCKET). The adapter's arguments (`app-server …`) are
// for an app-server of its own, and dropped.
import WebSocket from 'ws';

const socketPath = process.env.CODEFLOWER_CODEX_SOCKET;
if (!socketPath) {
  process.stderr.write('codex proxy: CODEFLOWER_CODEX_SOCKET is not set\n');
  process.exit(1);
}
const ws = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 64 * 1024 * 1024 });
const waiting = [];
let buffer = '';
const flush = () => {
  while (waiting.length && ws.readyState === WebSocket.OPEN) ws.send(waiting.shift());
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) waiting.push(line);
  }
  flush();
});
process.stdin.on('end', () => ws.close());
ws.on('open', flush);
ws.on('message', (data) => process.stdout.write(`${data}\n`));
ws.on('close', () => process.exit(0));
ws.on('error', (error) => {
  process.stderr.write(`codex proxy: ${error.message}\n`);
  process.exit(1);
});
