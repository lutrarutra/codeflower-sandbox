// OpenCode's own event stream (`GET /global/event`, server-sent events), read
// beside ACP. ACP relays the assistant's side of a turn the terminal UI
// started, but not the user's message, when the turn starts and ends, or a
// permission answered in the terminal; the bridge gets those from here as
// events of its own:
//   { type: 'prompt', sessionId, messageId, prompt }   a user message
//   { type: 'busy' | 'idle', sessionId }               a turn starts or ends
//   { type: 'permissionReplied', sessionId, toolCallId, reply }   once|always|reject

const RECONNECT_MS = 1000;
// User messages whose text has not arrived yet, and those already told.
const MAX_REMEMBERED = 1000;

export function watchEvents({ url, password, emit, log = () => {}, reconnectMs = RECONNECT_MS }) {
  const abort = new AbortController();
  const parse = createParser(emit);
  let connected = false;

  const connect = async () => {
    while (!abort.signal.aborted) {
      try {
        const response = await fetch(`${url}/global/event`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, accept: 'text/event-stream' },
          signal: abort.signal
        });
        if (!response.ok || !response.body) throw new Error(`${url}/global/event answered ${response.status}`);
        if (!connected) log('Following OpenCode events');
        connected = true;
        let buffer = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (data) parse(data);
          }
        }
      } catch (error) {
        // The server starts with the agent, a moment after it.
        if (abort.signal.aborted) return;
        if (connected) log(`OpenCode's events stopped: ${error.message}`);
        connected = false;
      }
      await new Promise((resolve) => setTimeout(resolve, reconnectMs).unref());
    }
  };
  void connect();
  return () => abort.abort();
}

export function createParser(emit) {
  const roles = new Map();
  const told = new Set();
  const status = new Map();
  // Permission request id -> the tool call ACP knows it by.
  const toolCalls = new Map();

  const forget = (map) => {
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
  };

  return (data) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const payload = event?.payload ?? event;
    const properties = payload?.properties;
    if (!properties || typeof properties !== 'object') return;
    switch (payload.type) {
      case 'message.updated': {
        const info = properties.info;
        if (typeof info?.id === 'string' && typeof info.role === 'string') {
          roles.set(info.id, info.role);
          forget(roles);
        }
        break;
      }
      case 'message.part.updated': {
        const part = properties.part;
        if (part?.type !== 'text' || typeof part.text !== 'string' || part.synthetic) break;
        if (roles.get(part.messageID) !== 'user' || told.has(part.messageID)) break;
        told.add(part.messageID);
        if (told.size > MAX_REMEMBERED) told.delete(told.values().next().value);
        emit({ type: 'prompt', sessionId: part.sessionID, messageId: part.messageID, prompt: [{ type: 'text', text: part.text }] });
        break;
      }
      case 'session.status': {
        const type = properties.status?.type;
        const sessionId = properties.sessionID;
        if (typeof sessionId !== 'string') break;
        // Retries count as working.
        const state = type === 'idle' ? 'idle' : 'busy';
        if (status.get(sessionId) === state) break;
        status.set(sessionId, state);
        forget(status);
        emit({ type: state, sessionId });
        break;
      }
      case 'permission.asked':
        if (typeof properties.id === 'string' && typeof properties.tool?.callID === 'string') {
          toolCalls.set(properties.id, properties.tool.callID);
          forget(toolCalls);
        }
        break;
      case 'permission.replied': {
        const toolCallId = toolCalls.get(properties.requestID);
        toolCalls.delete(properties.requestID);
        if (toolCallId === undefined) break;
        emit({ type: 'permissionReplied', sessionId: properties.sessionID, toolCallId, reply: properties.reply });
        break;
      }
    }
  };
}
