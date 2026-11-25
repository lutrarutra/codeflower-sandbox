import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditTranscript, redact } from '../src/audit.js';

test('redact hides home folders, tokens and e-mail addresses', () => {
  const text = 'cd /home/ana/x && cat /Users/bo/y; key sk-ant-abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstuvwx mail ana@example.org /codeflower-state/env/x';
  const out = redact(text);
  assert.equal(out, 'cd ~/x && cat ~/y; key [redacted] [redacted] mail [e-mail] /codeflower-state/…');
});

test('auditTranscript joins message chunks and keeps tool titles, not their output', () => {
  const entries = [
    { t: '1', kind: 'prompt', prompt: [{ type: 'text', text: 'Audit 10.1/x' }] },
    { t: '2', kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Hello ' } } },
    { t: '3', kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'there' } } },
    { t: '4', kind: 'update', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'secret thoughts' } } },
    { t: '5', kind: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run score', kind: 'execute', status: 'pending', rawInput: { command: 'x' }, content: [{ type: 'content', content: { type: 'text', text: 'DATA' } }] } },
    { t: '6', kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'OUTPUT' } }] } },
    { t: '7', kind: 'update', update: { sessionUpdate: 'usage_update', used: 1, size: 2 } },
    { t: '8', kind: 'update', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Done at /home/ana' } } },
    { t: '9', kind: 'turn_end', stopReason: 'end_turn' }
  ];
  assert.deepEqual(auditTranscript(entries), [
    { t: '1', role: 'user', text: 'Audit 10.1/x' },
    { t: '2', role: 'agent', text: 'Hello there' },
    { t: '5', role: 'tool', title: 'Run score', kind: 'execute', status: 'completed' },
    { t: '8', role: 'agent', text: 'Done at ~' },
    { t: '9', role: 'turn-end', stopReason: 'end_turn' }
  ]);
  assert.doesNotMatch(JSON.stringify(auditTranscript(entries)), /DATA|OUTPUT|secret thoughts/);
});
