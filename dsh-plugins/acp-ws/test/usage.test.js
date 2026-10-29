import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readCodexLimits } from '../src/codex-limits.js';
import { authFromStatus, claudeLimits, codexLimits, createUsage, dshTokens, tokenCounts } from '../src/usage.js';

const fakeAppServer = fileURLToPath(new URL('../fixtures/fake-app-server.js', import.meta.url));

test('token counts have every ACP field and a total', () => {
  assert.equal(tokenCounts(undefined), undefined);
  assert.equal(tokenCounts({ stopReason: 'end_turn' }), undefined);
  assert.deepEqual(tokenCounts({ inputTokens: 10, outputTokens: 5, cachedReadTokens: 3 }), {
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 3,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
    totalTokens: 18
  });
  assert.deepEqual(dshTokens({ inputTokens: 60, outputTokens: 7, cacheReadTokens: 40, reasoningTokens: 2, totalTokens: 107 }), {
    inputTokens: 60,
    outputTokens: 7,
    cachedReadTokens: 40,
    cachedWriteTokens: 0,
    thoughtTokens: 2,
    totalTokens: 107
  });
});

test("Claude Code's rate limits become percentages with reset times", () => {
  assert.deepEqual(claudeLimits({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.37, resetsAt: 1800000000 }), [
    { id: 'five_hour', label: '5-hour', usedPercent: 37, resetsAt: '2027-01-15T08:00:00.000Z', status: 'allowed' }
  ]);
  // Some versions name every window at once.
  const both = claudeLimits({
    status: 'allowed',
    rateLimitType: 'five_hour',
    unifiedWindows: {
      five_hour: { utilization: 0.5, resetsAt: 1800000000 },
      seven_day: { utilization: 0.1, resetsAt: 1800500000, status: 'allowed' }
    }
  });
  assert.deepEqual(both.map((limit) => [limit.id, Math.round(limit.usedPercent)]), [['five_hour', 50], ['seven_day', 10]]);
  assert.deepEqual(claudeLimits({ status: 'allowed' }), []);
});

test("Codex's rate limits are named by their window", () => {
  const { limits, plan, credits } = codexLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 },
      secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null },
      credits: { unlimited: false, balance: '42' },
      planType: 'pro'
    },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1800000000 }, planType: 'pro' },
      other: { limitId: 'other', limitName: 'GPT-5 mini', primary: { usedPercent: 3, windowDurationMins: 60 } }
    }
  });
  assert.deepEqual(
    limits.map((limit) => [limit.id, limit.label, limit.usedPercent, limit.status]),
    [
      ['five_hour', '5-hour', 100, 'rejected'],
      ['other:1h', 'GPT-5 mini 1-hour', 3, undefined]
    ]
  );
  assert.equal(plan, 'pro');
  assert.equal(credits, undefined);
  assert.deepEqual(codexLimits({ rateLimits: { credits: { unlimited: false, balance: 42 } } }).credits, { unlimited: false, balance: '42' });
});

test('the login tells subscriptions from keys', () => {
  assert.deepEqual(authFromStatus({ kind: 'account', label: 'ChatGPT Plus', account: { plan: 'plus', email: 'a@b.c' } }), {
    kind: 'subscription',
    plan: 'plus',
    label: 'ChatGPT Plus'
  });
  assert.deepEqual(authFromStatus({ kind: 'api_key', label: 'OpenAI API key' }), { kind: 'api_key', label: 'OpenAI API key' });
  assert.equal(authFromStatus({ kind: 'none' }), undefined);
});

test('a session adds up its turns and a running cost that starts over', () => {
  let changes = 0;
  const usage = createUsage({ costEstimate: true, onChange: () => changes++ });
  usage.opened('s', { tokens: { inputTokens: 1000, totalTokens: 1000 }, cost: { amount: 2, currency: 'USD' } });
  usage.update('s', { sessionUpdate: 'usage_update', used: 500, size: 1000, cost: { amount: 0.5, currency: 'USD' } });
  usage.update('s', { sessionUpdate: 'usage_update', used: 600, size: 1000, cost: { amount: 0.75, currency: 'USD' } });
  assert.deepEqual(usage.turnEnded('s', { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }), {
    usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 15 },
    cost: { amount: 0.75, currency: 'USD' }
  });
  // Resumed: the agent's query, and its cost, start over.
  usage.opened('s', { tokens: { inputTokens: 1000 } });
  usage.update('s', { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.1, currency: 'USD' } });
  usage.turnEnded('s', { stopReason: 'end_turn' });
  const [session] = usage.snapshot().sessions;
  assert.equal(session.tokens.inputTokens, 1010);
  assert.equal(session.tokens.totalTokens, 1015);
  assert.equal(session.cost.amount.toFixed(2), '2.85');
  assert.deepEqual(session.context, { used: 100, size: 1000 });
  // The worker's totals count only its own turns.
  assert.equal(usage.snapshot().totals.tokens.totalTokens, 15);
  assert.equal(usage.snapshot().totals.cost.amount.toFixed(2), '0.85');
  assert.ok(changes > 0);
});

test('counts reported beside ACP go to the turn that ends next', () => {
  const usage = createUsage();
  usage.reported('s', dshTokens({ inputTokens: 10, outputTokens: 5 }));
  usage.reported('s', dshTokens({ inputTokens: 1, outputTokens: 1 }));
  assert.equal(usage.turnEnded('s', { stopReason: 'end_turn' }).usage.totalTokens, 17);
  assert.equal(usage.turnEnded('s', { stopReason: 'end_turn' }), undefined);
});

test('quota is kept per login and survives in what is saved', () => {
  let saves = 0;
  const usage = createUsage({ onAccountChange: () => saves++ });
  usage.guessAuth('subscription');
  usage.claudeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2, resetsAt: 1800000000 });
  usage.update('s', {
    sessionUpdate: 'usage_update',
    used: 1,
    size: 2,
    _meta: { '_claude/rateLimit': { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1800500000 } }
  });
  assert.deepEqual(usage.snapshot().limits.map((limit) => limit.id), ['five_hour', 'seven_day']);
  const saved = usage.saved();
  assert.equal(saved.auth.kind, 'subscription');
  assert.ok(saves >= 3);

  // The next worker starts from it; the agent's own report outranks its files.
  const next = createUsage({ saved });
  assert.equal(next.snapshot().limits.length, 2);
  next.auth({ kind: 'account', account: { plan: 'max' } });
  next.guessAuth('api_key');
  assert.equal(next.authKind, 'subscription');
  // Another login's quota is not this one's.
  next.auth({ kind: 'api_key' });
  assert.deepEqual(next.snapshot().limits, []);
});

test("Codex's limits come from a separate app-server", async () => {
  const limits = await readCodexLimits([process.execPath, fakeAppServer], process.env);
  assert.equal(limits.rateLimits.primary.usedPercent, 37);
  const usage = createUsage();
  usage.codexRateLimits(limits);
  assert.deepEqual(usage.snapshot().auth, { kind: 'subscription', plan: 'plus' });
  assert.deepEqual(usage.snapshot().limits.map((limit) => [limit.label, limit.usedPercent]), [['5-hour', 37], ['Weekly', 12]]);

  await assert.rejects(readCodexLimits([process.execPath, fakeAppServer, '--signed-out'], process.env), /authentication required/);
  await assert.rejects(readCodexLimits([process.execPath, fakeAppServer, '--hang'], process.env, { timeoutMs: 200 }), /in time/);
  await assert.rejects(readCodexLimits(['/nonexistent/codex'], process.env), /ENOENT/);
});
