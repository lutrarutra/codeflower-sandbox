// The transcript of a paper audit (the codeflower-audit skill), for its sealed,
// public deliverables. `codeflower-audit seal` asks for it over the show socket
// (`{ op: 'audit-transcript' }`): the bridge, which alone writes a chat's
// transcript.jsonl, hands over what was said, so the agent's own files are not
// the only record of how the scores came about.
//
// What it keeps: the user's prompts, the agent's messages (chunks joined), the
// tools it called (title, kind and final status, not their input or output, which
// may hold data or the paper's text), shell commands the user ran, and the files
// shown. Home folders, tokens and e-mail addresses are redacted.

const HOME = /\/(?:home|Users)\/[^/\s"'`]+/g;
const STATE = /\/codeflower-state\/[^\s"'`]*/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const TOKENS = [
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi
];

/** Text with home folders, the state folder, tokens and e-mail addresses replaced. */
export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(HOME, '~').replace(STATE, '/codeflower-state/…');
  for (const pattern of TOKENS) out = out.replace(pattern, '[redacted]');
  return out.replace(EMAIL, '[e-mail]');
}

// The note the bridge adds before an orchestrator's message, for the agent alone.
const HIDDEN = ['codeflower/orchestratorNote'];
// An orchestrator's message, or its executor's question (orchestrators.js).
const FROM = 'codeflower/from';

function promptText(prompt) {
  if (!Array.isArray(prompt)) return '';
  return prompt
    .filter((block) => !HIDDEN.some((name) => block?._meta?.[name]))
    .map((block) => {
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'resource_link' || block?.type === 'resource') return `[${block.name ?? block.uri ?? block.resource?.uri ?? 'file'}]`;
      if (block?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A chat's transcript entries as the audit's records, oldest first. */
export function auditTranscript(entries) {
  const records = [];
  const tools = new Map();
  let message;
  const flush = () => {
    if (message) records.push({ ...message, text: redact(message.text) });
    message = undefined;
  };
  for (const entry of entries) {
    const update = entry.update ?? {};
    if (entry.kind === 'update' && update.sessionUpdate === 'agent_message_chunk') {
      const text = update.content?.type === 'text' ? update.content.text ?? '' : '';
      const id = update.messageId;
      if (message && (id === undefined || message.id === id)) message.text += text;
      else {
        flush();
        message = { t: entry.t, role: 'agent', text, ...(id !== undefined ? { id } : {}) };
      }
      continue;
    }
    if (entry.kind === 'update' && update.sessionUpdate === 'agent_thought_chunk') continue;
    if (entry.kind === 'update' && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
      const known = tools.get(update.toolCallId);
      if (known) {
        if (typeof update.title === 'string') known.title = redact(update.title);
        if (typeof update.status === 'string') known.status = update.status;
        continue;
      }
      flush();
      const record = {
        t: entry.t,
        role: 'tool',
        title: redact(update.title ?? update.name ?? 'tool'),
        ...(update.kind ? { kind: update.kind } : {}),
        ...(update.status ? { status: update.status } : {})
      };
      tools.set(update.toolCallId, record);
      records.push(record);
      continue;
    }
    if (entry.kind === 'prompt') {
      flush();
      const from = Array.isArray(entry.prompt) ? entry.prompt.find((block) => block?._meta?.[FROM])?._meta[FROM] : undefined;
      records.push({
        t: entry.t,
        role: from ? 'peer' : 'user',
        ...(from ? { from: from.kind, ...(typeof from.title === 'string' ? { title: redact(from.title) } : {}) } : {}),
        text: redact(promptText(entry.prompt))
      });
    } else if (entry.kind === 'sent') {
      flush();
      records.push({ t: entry.t, role: 'sent', text: redact(entry.text ?? ''), ...(entry.withheld ? { withheld: true } : {}) });
    } else if (entry.kind === 'shell') {
      flush();
      records.push({ t: entry.t, role: 'user-shell', text: redact(entry.command ?? '') });
    } else if (entry.kind === 'show') {
      flush();
      records.push({ t: entry.t, role: 'show', files: (entry.files ?? []).map((file) => redact(String(file))) });
    } else if (entry.kind === 'turn_end') {
      flush();
      records.push({ t: entry.t, role: 'turn-end', ...(entry.stopReason ? { stopReason: entry.stopReason } : {}) });
    }
  }
  flush();
  return records.map(({ id, ...record }) => record);
}
