import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'DEEPSEEK_API_KEY',
  'CODEFLOWER_OPENAI_COMPAT_API_KEY'
];
const fakeLogin = fileURLToPath(new URL('./fake-login.js', import.meta.url));

const input = createInterface({ input: process.stdin });
let nextSession = 1;
let nextRequest = 1;
let pendingPrompt;
// Turns that run until the test lets them finish, by session.
const longTasks = new Map();
const waiting = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = `agent-${nextRequest++}`;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

// Session settings, like Claude Code's mode and effort selectors.
const settings = new Map();

function configOptions(sessionId) {
  const values = settings.get(sessionId) ?? { mode: 'default', effort: 'medium' };
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: values.mode,
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' }
      ]
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: values.effort,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ]
    }
  ];
}

function reply(sessionId, id, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve(message.result);
    return;
  }
  switch (message.method) {
    case 'initialize': {
      const capabilities = message.params?.clientCapabilities ?? {};
      const authMethods = [{ id: 'api-key', name: 'API key', _meta: { 'api-key': { provider: 'openai' } } }];
      if (capabilities._meta?.['terminal-auth']) {
        authMethods.push({
          id: 'claude-ai-login',
          name: 'Claude Subscription',
          type: 'terminal',
          _meta: { 'terminal-auth': { command: process.execPath, args: [fakeLogin], label: 'Claude Login' } }
        });
      }
      if (capabilities.elicitation?.url) {
        authMethods.push({ id: 'chat-gpt-device-code', name: 'ChatGPT (device code)' });
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          authMethods,
          leakedLauncherToken: process.env.CODEFLOWER_TOKEN ?? null,
          credentialVariables: CREDENTIAL_VARIABLES.filter((name) => process.env[name] !== undefined),
          noBrowser: process.env.NO_BROWSER ?? null,
          argv: process.argv.slice(2),
          pid: process.pid
        }
      });
      break;
    }
    case 'authenticate':
      if (message.params.methodId === 'chat-gpt-device-code') {
        const response = await request('elicitation/create', {
          mode: 'url',
          url: 'https://auth.example.org/device',
          message: 'Sign in to ChatGPT and enter this code: ABCD-1234',
          elicitationId: 'login-1'
        });
        send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: 'login-1' } });
        send({ jsonrpc: '2.0', id: message.id, result: { accepted: response?.action === 'accept' } });
        break;
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { keyLength: message.params._meta?.['api-key']?.apiKey?.length ?? 0 }
      });
      break;
    case 'session/new': {
      const sessionId = `session-${nextSession++}`;
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: configOptions(sessionId) } });
      break;
    }
    case 'session/set_config_option': {
      const { sessionId, configId, value } = message.params;
      settings.set(sessionId, { mode: 'default', effort: 'medium', ...settings.get(sessionId), [configId]: value });
      send({ jsonrpc: '2.0', id: message.id, result: { configOptions: configOptions(sessionId) } });
      break;
    }
    case 'session/prompt': {
      const text = message.params.prompt?.[0]?.text;
      if (text === 'cancel me') {
        pendingPrompt = message.id;
        break;
      }
      if (text === 'leave plan mode') {
        const { sessionId } = message.params;
        settings.set(sessionId, { ...settings.get(sessionId), mode: 'default' });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: configOptions(sessionId) } }
        });
        reply(sessionId, message.id, 'left plan mode');
        break;
      }
      if (text === 'ask question') {
        // Shaped like Claude Code's AskUserQuestion form.
        const result = await request('elicitation/create', {
          mode: 'form',
          sessionId: message.params.sessionId,
          toolCallId: 'tool-ask',
          message: 'Which dataset?',
          requestedSchema: {
            type: 'object',
            properties: {
              question_0: {
                type: 'string',
                title: 'Data',
                oneOf: [
                  { const: 'Cells', title: 'Cells' },
                  { const: 'Genes', title: 'Genes', description: 'Expression table' }
                ]
              },
              question_0_custom: { type: 'string', title: 'Other' }
            }
          }
        });
        reply(message.params.sessionId, message.id, `answer ${result.action} ${JSON.stringify(result.content ?? {})}`);
        break;
      }
      if (text === 'long task') {
        const { sessionId } = message.params;
        longTasks.set(sessionId, message.id);
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } } }
        });
        break;
      }
      if (text === 'approve plan') {
        // Like Claude Code's ExitPlanMode: the kind comes with the tool call, not the request.
        const { sessionId } = message.params;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'plan-1', title: 'Approve Plan', kind: 'switch_mode' } }
        });
        const result = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'plan-1' },
          options: [{ optionId: 'allow', name: 'Yes', kind: 'allow_once' }]
        });
        reply(sessionId, message.id, `outcome ${result.outcome.optionId ?? result.outcome.outcome}`);
        break;
      }
      if (text === 'ask permission') {
        const result = await request('session/request_permission', {
          sessionId: message.params.sessionId,
          toolCall: { toolCallId: 'tool-1', title: 'Run ls' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        });
        reply(message.params.sessionId, message.id, `outcome ${result.outcome.optionId ?? result.outcome.outcome}`);
        break;
      }
      reply(message.params.sessionId, message.id, `reply to ${text} in ${message.params.sessionId}`);
      break;
    }
    case 'session/cancel':
      if (pendingPrompt !== undefined) {
        send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } });
        pendingPrompt = undefined;
      }
      break;
    case 'fake/finish': {
      const { sessionId } = message.params;
      const id = longTasks.get(sessionId);
      longTasks.delete(sessionId);
      if (id !== undefined) reply(sessionId, id, 'done');
      break;
    }
    case 'session/resume':
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});
