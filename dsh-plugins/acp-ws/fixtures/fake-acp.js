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
// Steering requests, as the agent got them.
const steers = [];
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
// Whether the client takes subagents as sessions of their own (ACP subagents
// RFD), and the children still running, by id: their parent.
let clientSubagents = false;
let nextChild = 1;
const runningChildren = new Map();

function update(sessionId, value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
}

// A subagent at work: its settings, a message and a tool call, under its own id.
function childWork(childId) {
  update(childId, {
    sessionUpdate: 'config_option_update',
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small model' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] }
    ]
  });
  update(childId, { sessionUpdate: 'usage_update', used: 500, size: 100000 });
  update(childId, { sessionUpdate: 'tool_call', toolCallId: `${childId}-tool`, title: 'Read notes.txt', kind: 'read', status: 'completed' });
  update(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child ' } });
  update(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'found it' } });
}

// `spawn subagent` (the RFD), `spawn draft subagent` (the draft it grew from),
// or the flat stream of an agent whose client does not take subagents.
async function spawnSubagent(sessionId, text) {
  const childId = `child-${nextChild++}`;
  const task = 'Find the notes';
  const draft = text.includes('draft');
  if (!clientSubagents) {
    const meta = { claudeCode: { parentToolUseId: 'agent-tool' } };
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: `${childId}-tool`, title: 'Read notes.txt', status: 'completed', _meta: meta });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'child found it' }, _meta: meta });
    return;
  }
  if (draft) {
    update(sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: childId, name: 'Notes finder', task, capabilities: {} });
  } else {
    update(sessionId, {
      sessionUpdate: 'subagent_update',
      sessionId: childId,
      title: 'Notes finder (Explore)',
      description: 'Find the notes',
      capabilities: { cancel: {} },
      state: { state: 'running' }
    });
    const message = { messageId: 'agent-tool', senderSessionId: sessionId, recipientSessionId: childId, content: [{ type: 'text', text: task }] };
    update(sessionId, { sessionUpdate: 'session_message', ...message });
    update(childId, { sessionUpdate: 'session_message', ...message });
  }
  childWork(childId);
  if (text.includes('child asks')) {
    const result = await request('session/request_permission', {
      sessionId: childId,
      toolCall: { toolCallId: `${childId}-ask`, title: 'Run grep' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    });
    update(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `child outcome ${result.outcome.optionId ?? result.outcome.outcome}` } });
  }
  if (text.includes('keep running')) {
    runningChildren.set(childId, { parentId: sessionId, draft });
    return;
  }
  endChild(childId, sessionId, draft, 'end_turn');
}

function endChild(childId, parentId, draft, stopReason) {
  runningChildren.delete(childId);
  if (draft) {
    update(parentId, { sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: stopReason === 'end_turn' ? 'completed' : 'cancelled' });
    return;
  }
  if (stopReason === 'end_turn') {
    update(parentId, {
      sessionUpdate: 'session_message',
      messageId: 'agent-tool:reply',
      senderSessionId: childId,
      recipientSessionId: parentId,
      content: [{ type: 'text', text: 'The notes are in notes.txt' }]
    });
  }
  update(parentId, { sessionUpdate: 'subagent_update', sessionId: childId, state: { state: 'idle', stopReason } });
}

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
  if (process.argv[2] === 'acp') {
    // As `opencode acp` offers them: provider/model strings, one model through mode changes.
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: values.model ?? 'opencode/big-pickle',
      options: ['opencode/big-pickle', 'openrouter/openrouter/free', 'openrouter/qwen/qwen3-32b'].map((value) => ({ value, name: value }))
    });
  }
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

function reply(sessionId, id, text, usage) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', ...(usage ? { usage } : {}) } });
}

input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined && waiting.has(message.id)) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve(message.result);
    return;
  }
  // The MCP servers a session was started with, for tests; none adds nothing.
  const mcpEcho = (message) => (message.params?.mcpServers?.length ? { mcpServers: message.params.mcpServers } : {});
  // Like dsh, which fails a session start on an MCP server that does not
  // start: here one whose command or URL contains failing-mcp.
  const failingMcp = (message.params?.mcpServers ?? []).find((server) => `${server.command ?? server.url}`.includes('failing-mcp'));
  if (failingMcp && ['session/new', 'session/resume', 'session/load'].includes(message.method)) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: { details: `mcp-client(${failingMcp.name}): initial connection or tool synchronization failed` }
      }
    });
    return;
  }
  switch (message.method) {
    case 'initialize': {
      const capabilities = message.params?.clientCapabilities ?? {};
      clientSubagents = typeof capabilities.subagents === 'object' && capabilities.subagents !== null;
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
          agentCapabilities: {
            // Like Codex and dsh: stdio and http MCP servers, no sse.
            mcpCapabilities: { http: true },
            ...(process.argv.includes('--no-system-prompt')
              ? {}
              : { sessionCapabilities: { systemPrompt: { mode: { append: {} } } } })
          },
          leakedAppToken: process.env.CODEFLOWER_TOKEN ?? null,
          credentialVariables: CREDENTIAL_VARIABLES.filter((name) => process.env[name] !== undefined),
          noBrowser: process.env.NO_BROWSER ?? null,
          opencodeDatabase: process.env.OPENCODE_DB ?? null,
          pluginSeed: process.env.CLAUDE_CODE_PLUGIN_SEED_DIR ?? null,
          subagents: clientSubagents,
          codexConfig: process.env.CODEX_CONFIG ?? null,
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
      tasks.set(sessionId, {
        systemPrompt: message.params?.systemPrompt?.content?.[0]?.text ?? null,
        mcp: (message.params?.mcpServers ?? []).map((server) => server.command ?? server.url)
      });
      sessionMeta.set(sessionId, message.params?._meta ?? null);
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId, configOptions: configOptions(sessionId), ...mcpEcho(message) } });
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
      if (text === 'fail me') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
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
      if (text === 'approve plan' || text?.startsWith('approve plan in ')) {
        // Like Claude Code's ExitPlanMode: the kind comes with the tool call, not the request.
        // `approve plan in <path>`: the file Claude Code wrote the plan to.
        const { sessionId } = message.params;
        const planFilePath = text.slice('approve plan in '.length) || undefined;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'plan-1', title: 'Approve Plan', kind: 'switch_mode' } }
        });
        const result = await request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId: 'plan-1', ...(planFilePath ? { rawInput: { plan: 'The plan', planFilePath } } : {}) },
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
        if (state.task.includes('use tokens')) {
          const fd = Number(process.env.CODEFLOWER_USAGE_FD);
          send({
            jsonrpc: '2.0',
            method: '_auth/status_update',
            params: { authStatus: { kind: 'account', label: 'Claude Max', account: { plan: 'max' } } }
          });
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'usage_update',
                cost: { amount: 0.25, currency: 'USD' },
                _meta: { '_claude/rateLimit': { rateLimitType: 'five_hour', utilization: 0.25, resetsAt: 1800000000 } }
              }
            }
          });
          if (fd) {
            writeSync(fd, `${JSON.stringify({ sessionId, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, totalTokens: 17 } })}\n`);
            writeSync(fd, `${JSON.stringify({ sessionId: 'sub-1', parentSessionId: sessionId, usage: { inputTokens: 1, outputTokens: 1 } })}\n`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          reply(
            sessionId,
            message.id,
            'worked with usage',
            fd ? undefined : { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, totalTokens: 170 }
          );
          break;
        }
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
            `system prompt ${state.systemPrompt ? 'given' : 'missing'}, turn ${state.turns}` +
            `${state.mcp?.length ? `, mcp ${state.mcp.join(' ')}` : ''})`
        );
        break;
      }
      if (text === 'run failing command') {
        // As dsh-acp reports a command that exited 1: completed, with the marker.
        const { sessionId } = message.params;
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'bash-1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'false' } });
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'bash-1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '[exit code: 1]' } }]
        });
        reply(sessionId, message.id, 'it failed');
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
      if (text?.startsWith('spawn ')) {
        await spawnSubagent(message.params.sessionId, text);
        reply(message.params.sessionId, message.id, 'parent done');
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
      // A subagent stops alone.
      if (runningChildren.has(message.params?.sessionId)) {
        const { parentId, draft } = runningChildren.get(message.params.sessionId);
        endChild(message.params.sessionId, parentId, draft, 'cancelled');
        break;
      }
      if (pendingPrompt !== undefined) {
        send({ jsonrpc: '2.0', id: pendingPrompt, result: { stopReason: 'cancelled' } });
        pendingPrompt = undefined;
      }
      break;
    // ACP steering, as Claude Code does it: into the running turn, or back to the client without one.
    case '_session/steering': {
      const { sessionId, prompt } = message.params;
      steers.push(message.params);
      if (!longTasks.has(sessionId)) {
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } });
        break;
      }
      send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'injected' } });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steered by ${prompt[0].text}` } } }
      });
      break;
    }
    case 'fake/childSays': {
      update(message.params.childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.params.text } });
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    }
    case 'fake/finishChild': {
      const { childId } = message.params;
      const child = runningChildren.get(childId);
      if (child) endChild(childId, child.parentId, child.draft, 'end_turn');
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    }
    case 'fake/steers':
      send({ jsonrpc: '2.0', id: message.id, result: { steers } });
      break;
    case 'fake/finish': {
      const { sessionId } = message.params;
      const id = longTasks.get(sessionId);
      longTasks.delete(sessionId);
      if (id !== undefined) reply(sessionId, id, 'done');
      break;
    }
    // As the Claude Code adapter: lets go of a session, which it can resume later.
    case 'session/close':
      tasks.delete(message.params?.sessionId);
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      break;
    case 'session/resume':
      if (process.argv.includes('--no-resume')) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        break;
      }
      if (process.argv.includes('--resume-fails')) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Session not found' } });
        break;
      }
      costs.delete(message.params?.sessionId);
      sessionMeta.set(message.params?.sessionId, message.params?._meta ?? null);
      if (!tasks.has(message.params?.sessionId)) tasks.set(message.params?.sessionId, { systemPrompt: null });
      send({ jsonrpc: '2.0', id: message.id, result: mcpEcho(message) });
      break;
    case 'session/load': {
      // Like agents without session/resume: the history comes back first.
      const { sessionId } = message.params;
      if (!tasks.has(sessionId)) tasks.set(sessionId, { systemPrompt: null });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } } }
      });
      send({ jsonrpc: '2.0', id: message.id, result: mcpEcho(message) });
      break;
    }
    default:
      if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});
