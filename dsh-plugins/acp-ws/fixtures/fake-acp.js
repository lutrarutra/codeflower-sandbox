import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
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
// What a task session was told: its system prompt and its task (codeflower task).
const tasks = new Map();
// What each session's creator put in its _meta, e.g. the bridge's rate limit request.
const sessionMeta = new Map();
// A running cost per session, like Claude Code's, which starts over on resume.
const costs = new Map();

function configOptions(sessionId) {
  const values = settings.get(sessionId) ?? { mode: 'default', effort: 'medium' };
  const options = [
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
      // The small model thinks less.
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        ...(values.model?.[1] === 'small' ? [] : [{ value: 'high', name: 'High' }])
      ]
    }
  ];
  if (process.argv.includes('--models')) {
    // Grouped by provider, with [provider, model] values, like dsh's.
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: values.model ?? ['acme', 'large'],
      options: [
        {
          group: 'acme',
          name: 'Acme',
          options: [
            { value: ['acme', 'large'], name: 'Acme Large' },
            { value: ['acme', 'small'], name: 'Acme Small' }
          ]
        }
      ]
    });
  }
  return options;
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
          agentCapabilities: process.argv.includes('--no-system-prompt')
            ? {}
            : { sessionCapabilities: { systemPrompt: { mode: { append: {} } } } },
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
      tasks.set(sessionId, { systemPrompt: message.params?.systemPrompt?.content?.[0]?.text ?? null });
      sessionMeta.set(sessionId, message.params?._meta ?? null);
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
      if (text?.startsWith('Before this run ends')) {
        // codeflower task's status check: the task text says how it went.
        const task = tasks.get(message.params.sessionId)?.task ?? '';
        const status = task.includes('never done')
          ? 'incomplete — more to do'
          : task.includes('impossible')
            ? 'impossible — the data is missing'
            : 'complete — all done';
        reply(message.params.sessionId, message.id, `TASK_STATUS: ${status}`);
        break;
      }
      if (text?.includes('task:')) {
        // A codeflower task: ask what a user would answer, write the report, report back.
        const { sessionId } = message.params;
        const state = tasks.get(sessionId);
        state.task ??= text;
        state.turns = (state.turns ?? 0) + 1;
        if (text.includes('hang')) {
          pendingPrompt = message.id;
          break;
        }
        const permission = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: `tool-${state.turns}`, title: 'Run analysis.py' },
          options: [
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' }
          ]
        });
        const question = await request('elicitation/create', {
          mode: 'form',
          sessionId,
          message: 'Which samples?',
          requestedSchema: { type: 'object', properties: {} }
        });
        const report = /at (\S+report\.html)/.exec(text)?.[1];
        if (report && !text.includes('no report file')) {
          mkdirSync(dirname(report), { recursive: true });
          writeFileSync(report, '<html></html>');
        }
        reply(
          sessionId,
          message.id,
          `worked (${permission.outcome.optionId}, question ${question.action}, ` +
            `system prompt ${state.systemPrompt ? 'given' : 'missing'}, turn ${state.turns})`
        );
        break;
      }
      if (text === 'what meta') {
        reply(message.params.sessionId, message.id, JSON.stringify(sessionMeta.get(message.params.sessionId)));
        break;
      }
      if (text === 'use tokens') {
        // Like Claude Code and Codex, or with CODEFLOWER_USAGE_FD like dsh and its plugin.
        const { sessionId } = message.params;
        const cost = (costs.get(sessionId) ?? 0) + 0.25;
        costs.set(sessionId, cost);
        const fd = Number(process.env.CODEFLOWER_USAGE_FD);
        if (!fd) {
          send({
            jsonrpc: '2.0',
            method: '_auth/status_update',
            params: { authStatus: { kind: 'account', label: 'Claude Max', account: { plan: 'max' } } }
          });
        }
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 1000,
              size: 200000,
              cost: { amount: cost, currency: 'USD' },
              _meta: { '_claude/rateLimit': { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.25, resetsAt: 1800000000 } }
            }
          }
        });
        if (sessionMeta.get(sessionId)?.claudeCode?.emitRawSDKMessages) {
          send({
            jsonrpc: '2.0',
            method: '_claude/sdkMessage',
            params: {
              sessionId,
              message: {
                type: 'rate_limit_event',
                rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1800500000 }
              }
            }
          });
        }
        if (fd) {
          writeSync(fd, `${JSON.stringify({ sessionId, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 } })}\n`);
          writeSync(fd, `${JSON.stringify({ sessionId: 'sub-1', parentSessionId: sessionId, usage: { inputTokens: 1, outputTokens: 1 } })}\n`);
          // Give the bridge the pipe's lines before the answer.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            stopReason: 'end_turn',
            ...(fd ? {} : { usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, totalTokens: 170 } })
          }
        });
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
      costs.delete(message.params?.sessionId);
      sessionMeta.set(message.params?.sessionId, message.params?._meta ?? null);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});
