// The shared app-server's own notifications, read beside ACP. Codex's
// adapter relays the assistant's side of a turn its terminal UI started, but
// not the user's message; the bridge follows the chats a terminal UI has here
// (follow), as events of its own, as OpenCode's (../opencode/events.js):
//   { type: 'prompt', sessionId, prompt }   a user message
//   { type: 'busy' | 'idle', sessionId }     a turn starts or ends
import WebSocket from 'ws';

const RECONNECT_MS = 1000;

export function watchEvents({ socketPath, emit, log = () => {}, reconnectMs = RECONNECT_MS }) {
  const parse = createParser(emit);
  const followed = new Set();
  let ws;
  let stopped = false;
  let nextId = 1;

  const subscribe = (threadId) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    // Resuming a loaded thread on another connection subscribes it to the thread.
    ws.send(JSON.stringify({ id: `cf-watch-${nextId++}`, method: 'thread/resume', params: { threadId } }));
  };
  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(`ws+unix://${socketPath}:/`, { maxPayload: 64 * 1024 * 1024 });
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: `cf-watch-${nextId++}`,
          method: 'initialize',
          params: { clientInfo: { name: 'codeflower-bridge', title: 'code flower', version: '1' }, capabilities: { experimentalApi: true } }
        })
      );
      ws.send(JSON.stringify({ method: 'initialized' }));
      for (const threadId of followed) subscribe(threadId);
    });
    ws.on('message', (data) => parse(String(data)));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (stopped) return;
      setTimeout(connect, reconnectMs).unref();
    });
  };
  // The app-server starts with the agent, a moment before.
  setTimeout(connect, 0).unref();
  return {
    follows: (threadId) => followed.has(threadId),
    follow(threadId) {
      if (followed.has(threadId)) return;
      followed.add(threadId);
      subscribe(threadId);
    },
    stop() {
      stopped = true;
      ws?.close();
    }
  };
}

export function createParser(emit) {
  return (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const params = message?.params;
    if (typeof message?.method !== 'string' || typeof params?.threadId !== 'string' || message.id !== undefined) return;
    const sessionId = params.threadId;
    switch (message.method) {
      case 'turn/started':
        emit({ type: 'busy', sessionId });
        break;
      case 'turn/completed':
        emit({ type: 'idle', sessionId });
        break;
      case 'item/started': {
        const item = params.item;
        if (item?.type !== 'userMessage' || !Array.isArray(item.content)) break;
        const prompt = item.content
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => ({ type: 'text', text: part.text }));
        if (prompt.length) emit({ type: 'prompt', sessionId, prompt });
        break;
      }
    }
  };
}
