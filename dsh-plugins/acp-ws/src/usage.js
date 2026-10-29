// Token counts, spend, and subscription quota, read from the ACP traffic the
// bridge relays and from what the agents report beside it. Like activity, only
// numbers leave the bridge, never what the chats say.

// ACP's `Usage` fields; every count the bridge keeps has all of them.
export const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
  'thoughtTokens',
  'totalTokens'
];

const LIMIT_LABELS = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_overage_included: 'Weekly (with extra usage)',
  overage: 'Extra usage'
};

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function emptyTokens() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

/** ACP `Usage` with every field, or undefined when it holds no counts. */
export function tokenCounts(usage) {
  if (!object(usage) || !TOKEN_FIELDS.some((field) => Number.isFinite(usage[field]))) return undefined;
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, count(usage[field])]));
  if (!Number.isFinite(usage.totalTokens)) {
    tokens.totalTokens = tokens.inputTokens + tokens.cachedReadTokens + tokens.cachedWriteTokens + tokens.outputTokens;
  }
  return tokens;
}

export function addTokens(a, b) {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, count(a?.[field]) + count(b?.[field])]));
}

export function addCost(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  // Currencies never mix within one agent; a different one replaces the sum.
  return a.currency === b.currency ? { amount: a.amount + b.amount, currency: a.currency } : { ...b };
}

/** The counts dsh's usage plugin reports for one model call, as ACP `Usage`. */
export function dshTokens(usage) {
  if (!object(usage)) return undefined;
  return tokenCounts({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens: usage.cacheReadTokens,
    cachedWriteTokens: usage.cacheWriteTokens,
    thoughtTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens
  });
}

const isoFromSeconds = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);

/**
 * Claude Code's `rate_limit_event` info: one window per event, with the
 * utilization as a fraction; some versions add all windows in `unifiedWindows`.
 */
export function claudeLimits(info) {
  if (!object(info)) return [];
  const windows = object(info.unifiedWindows) ? Object.entries(info.unifiedWindows).filter(([, window]) => object(window)) : [];
  if (windows.length) {
    return windows.map(([id, window]) => ({
      id,
      label: LIMIT_LABELS[id] ?? id,
      usedPercent: Number.isFinite(window.utilization) ? window.utilization * 100 : null,
      resetsAt: isoFromSeconds(window.resetsAt),
      ...(window.status ? { status: window.status } : {})
    }));
  }
  if (typeof info.rateLimitType !== 'string') return [];
  return [
    {
      id: info.rateLimitType,
      label: LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType,
      usedPercent: Number.isFinite(info.utilization) ? info.utilization * 100 : null,
      resetsAt: isoFromSeconds(info.resetsAt),
      ...(typeof info.status === 'string' ? { status: info.status } : {})
    }
  ];
}

function windowName(minutes) {
  if (minutes === 300) return ['five_hour', '5-hour'];
  if (minutes === 10080) return ['seven_day', 'Weekly'];
  if (!Number.isFinite(minutes)) return ['window', 'Limit'];
  if (minutes < 60) return [`${minutes}m`, `${minutes}-minute`];
  if (minutes < 1440) return [`${Math.round(minutes / 60)}h`, `${Math.round(minutes / 60)}-hour`];
  return [`${Math.round(minutes / 1440)}d`, `${Math.round(minutes / 1440)}-day`];
}

/** Codex app-server's `account/rateLimits/read` result: limits, credits, plan. */
export function codexLimits(response) {
  if (!object(response)) return { limits: [] };
  const byId = object(response.rateLimitsByLimitId) ? Object.entries(response.rateLimitsByLimitId) : [];
  const snapshots = byId.filter(([, snapshot]) => object(snapshot));
  if (!snapshots.length && object(response.rateLimits)) snapshots.push([response.rateLimits.limitId ?? 'codex', response.rateLimits]);
  const limits = [];
  let credits;
  let plan;
  for (const [fallbackId, snapshot] of snapshots) {
    const limitId = snapshot.limitId ?? fallbackId;
    // Other limits than Codex's own (e.g. a model's) are named after it.
    const scope = limitId === 'codex' ? '' : `${snapshot.limitName ?? limitId} `;
    for (const window of [snapshot.primary, snapshot.secondary]) {
      if (!object(window)) continue;
      const [id, label] = windowName(window.windowDurationMins);
      const usedPercent = Number.isFinite(window.usedPercent) ? window.usedPercent : null;
      limits.push({
        id: scope ? `${limitId}:${id}` : id,
        label: `${scope}${label}`,
        usedPercent,
        resetsAt: isoFromSeconds(window.resetsAt),
        ...(usedPercent !== null && usedPercent >= 100 ? { status: 'rejected' } : {})
      });
    }
    if (object(snapshot.credits) && !credits && (snapshot.credits.unlimited === true || snapshot.credits.balance != null)) {
      credits = {
        unlimited: snapshot.credits.unlimited === true,
        ...(snapshot.credits.balance != null ? { balance: String(snapshot.credits.balance) } : {})
      };
    }
    plan ??= typeof snapshot.planType === 'string' ? snapshot.planType : undefined;
  }
  return { limits, ...(credits ? { credits } : {}), ...(plan ? { plan } : {}) };
}

/** The agents' `_auth/status_update` (Claude Code, Codex): who pays for the tokens. */
export function authFromStatus(status) {
  if (!object(status) || typeof status.kind !== 'string') return undefined;
  const kind =
    status.kind === 'account'
      ? 'subscription'
      : ['api_key', 'gateway', 'external'].includes(status.kind)
        ? 'api_key'
        : undefined;
  if (!kind) return undefined;
  const plan = status.account?.plan;
  return {
    kind,
    ...(typeof plan === 'string' && plan ? { plan } : {}),
    ...(typeof status.label === 'string' && status.label ? { label: status.label.slice(0, 100) } : {})
  };
}

/**
 * One worker's usage. Session totals start from what the session store
 * recorded and grow with each turn; quota and the login are account-wide and
 * outlive the worker in `saved()`.
 */
export function createUsage({ costEstimate = false, saved, onChange = () => {}, onAccountChange = () => {} } = {}) {
  // Session id -> { tokens, cost?, context?, lastCost?, pending?, turnCost?, seeded }
  const sessions = new Map();
  let auth = object(saved?.auth) ? saved.auth : undefined;
  const limits = new Map((Array.isArray(saved?.limits) ? saved.limits : []).map((limit) => [limit.id, limit]));
  let limitsUpdatedAt = typeof saved?.limitsUpdatedAt === 'string' ? saved.limitsUpdatedAt : null;
  let credits = object(saved?.credits) ? saved.credits : undefined;
  let totals = { tokens: emptyTokens() };

  const session = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) sessions.set(sessionId, (state = { tokens: emptyTokens(), seeded: false }));
    return state;
  };

  // Whether the agent itself reported the login, which then wins over its files.
  let authReported = false;

  const accountChanged = () => {
    onAccountChange();
    onChange();
  };

  const setAuth = (next) => {
    if (JSON.stringify(next) === JSON.stringify(auth)) return;
    // Another login: its quota is not this one's.
    if (auth && (auth.kind !== next.kind || (auth.plan && next.plan && auth.plan !== next.plan))) {
      limits.clear();
      limitsUpdatedAt = null;
      credits = undefined;
    }
    auth = next;
    accountChanged();
  };

  const setLimits = (next) => {
    for (const limit of next) limits.set(limit.id, limit);
    limitsUpdatedAt = new Date().toISOString();
  };

  function claudeRateLimit(info) {
    const next = claudeLimits(info);
    if (!next.length) return;
    setLimits(next);
    accountChanged();
  }

  return {
    /** A session the agent loaded: adds what earlier workers recorded, once. */
    opened(sessionId, stored) {
      const state = session(sessionId);
      // A resumed or loaded session runs a new agent query, whose cost starts over.
      state.lastCost = undefined;
      if (state.seeded) return;
      state.seeded = true;
      state.tokens = addTokens(state.tokens, stored?.tokens);
      state.cost = addCost(state.cost, object(stored?.cost) ? stored.cost : undefined);
      onChange();
    },

    /** Counts reported beside ACP (dsh's plugin), given to the turn that ends next. */
    reported(sessionId, tokens) {
      if (!tokens) return;
      const state = session(sessionId);
      state.pending = addTokens(state.pending, tokens);
    },

    /** A `usage_update`: how full the context is, the running cost, and Claude Code's quota. */
    update(sessionId, update) {
      if (!object(update) || update.sessionUpdate !== 'usage_update') return;
      const state = session(sessionId);
      if (Number.isFinite(update.used) && Number.isFinite(update.size)) state.context = { used: update.used, size: update.size };
      const cost = update.cost;
      if (object(cost) && Number.isFinite(cost.amount) && typeof cost.currency === 'string') {
        // A running total of the agent's query; a smaller one means it started over.
        const last = state.lastCost;
        const delta = last && last.currency === cost.currency && cost.amount >= last.amount ? cost.amount - last.amount : cost.amount;
        state.lastCost = { amount: cost.amount, currency: cost.currency };
        if (delta > 0) state.turnCost = addCost(state.turnCost, { amount: delta, currency: cost.currency });
      }
      const rateLimit = update._meta?.['_claude/rateLimit'];
      if (object(rateLimit)) claudeRateLimit(rateLimit);
      onChange();
    },

    /**
     * A finished turn's counts: the prompt result's `usage`, or what was
     * reported beside ACP. Returns what the turn added, for the transcript.
     */
    turnEnded(sessionId, result) {
      const state = session(sessionId);
      const tokens = tokenCounts(result?.usage) ?? state.pending;
      const cost = state.turnCost;
      state.pending = undefined;
      state.turnCost = undefined;
      if (!tokens && !cost) return undefined;
      state.tokens = addTokens(state.tokens, tokens);
      state.cost = addCost(state.cost, cost);
      totals = { tokens: addTokens(totals.tokens, tokens), cost: addCost(totals.cost, cost) };
      onChange();
      return { ...(tokens ? { usage: tokens } : {}), ...(cost ? { cost } : {}) };
    },

    forget(sessionId) {
      if (sessions.delete(sessionId)) onChange();
    },

    auth(status) {
      const next = authFromStatus(status);
      if (!next) return;
      authReported = true;
      setAuth(next);
    },

    /** The login read from the agent's files, until the agent reports its own. */
    guessAuth(kind) {
      if (authReported || !kind || auth?.kind === kind) return;
      setAuth({ kind });
    },

    claudeRateLimit,

    codexRateLimits(response) {
      const { limits: next, credits: nextCredits, plan } = codexLimits(response);
      // Codex lists the windows that apply now, so stale ones go.
      limits.clear();
      setLimits(next);
      credits = nextCredits;
      if (plan && auth?.kind !== 'api_key' && auth?.plan !== plan) auth = { ...auth, kind: 'subscription', plan };
      accountChanged();
    },

    get limitsUpdatedAt() {
      return limitsUpdatedAt;
    },

    get authKind() {
      return auth?.kind;
    },

    /** What outlives the worker: the login's quota. */
    saved() {
      return { auth, limits: [...limits.values()], limitsUpdatedAt, ...(credits ? { credits } : {}) };
    },

    /** The account, the worker's totals, and the loaded sessions' totals by key. */
    snapshot(keyOf = (sessionId) => sessionId) {
      return {
        auth: auth ?? { kind: 'unknown' },
        limits: [...limits.values()],
        limitsUpdatedAt,
        ...(credits ? { credits } : {}),
        costEstimate,
        totals,
        sessions: [...sessions.entries()].map(([sessionId, state]) => ({
          key: keyOf(sessionId),
          tokens: state.tokens,
          ...(state.cost ? { cost: state.cost } : {}),
          ...(state.context ? { context: state.context } : {})
        }))
      };
    }
  };
}
