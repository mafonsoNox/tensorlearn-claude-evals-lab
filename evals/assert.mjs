// Policy eval for the claims-core live-status regression.
// evaluate(observation) inspects one recorded run and reports whether it broke
// CACHE-1 (per-customer freshness cache), RATE-1 (claims-core rate limit) or
// PRIVACY-1 (no clinical payload in logs). It only reads observed behaviour:
// it never looks at fixture names, source files or implementation labels, and
// it never mutates the observation it is given (it sorts private copies).

const WINDOW_MS = 1000;
const MAX_MESSAGES_PER_CHECK = 5;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEvent(value) {
  return isPlainObject(value)
    && typeof value.customerCode === 'string' && value.customerCode.length > 0
    && typeof value.atMs === 'number' && Number.isFinite(value.atMs);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// EVIDENCE: the observation must contain everything the three checks need.
// Returns a list of problems; an empty list means the evidence is usable.
function checkEvidence(observation) {
  if (!isPlainObject(observation)) {
    return ['EVIDENCE: observation must be an object with requests, upstreamCalls, responses, logs and requirements'];
  }
  const problems = [];
  for (const field of ['requests', 'upstreamCalls', 'responses', 'logs']) {
    if (!Array.isArray(observation[field])) problems.push(`EVIDENCE: observation.${field} must be an array`);
  }
  const req = observation.requirements;
  if (!isPlainObject(req)) {
    problems.push('EVIDENCE: observation.requirements is missing or not an object');
  } else {
    if (!isPositiveNumber(req.maxRequestsPerSecond)) problems.push('EVIDENCE: requirements.maxRequestsPerSecond must be a positive number');
    if (!isPositiveNumber(req.cacheTtlMs)) problems.push('EVIDENCE: requirements.cacheTtlMs must be a positive number');
    if (!Array.isArray(req.forbiddenLogFragments)
      || !req.forbiddenLogFragments.every(f => typeof f === 'string' && f.length > 0)) {
      problems.push('EVIDENCE: requirements.forbiddenLogFragments must be an array of non-empty strings');
    }
  }
  if (problems.length > 0) return problems;

  if (observation.requests.length === 0) problems.push('EVIDENCE: no requests were recorded, so the run proves nothing');
  observation.requests.forEach((r, i) => {
    if (!isEvent(r)) problems.push(`EVIDENCE: requests[${i}] must be {customerCode: string, atMs: finite number}`);
  });
  observation.upstreamCalls.forEach((c, i) => {
    if (!isEvent(c)) problems.push(`EVIDENCE: upstreamCalls[${i}] must be {customerCode: string, atMs: finite number}`);
  });
  observation.responses.forEach((r, i) => {
    if (!isPlainObject(r) || typeof r.customerCode !== 'string') problems.push(`EVIDENCE: responses[${i}] must be an object with a customerCode`);
  });
  observation.logs.forEach((line, i) => {
    if (typeof line !== 'string') problems.push(`EVIDENCE: logs[${i}] must be a string`);
  });
  return problems.slice(0, MAX_MESSAGES_PER_CHECK * 4);
}

// CACHE-1: per customer, two consecutive upstream calls must be at least
// cacheTtlMs apart. A refresh at exactly cacheTtlMs is allowed.
function checkCache(upstreamCalls, ttlMs) {
  const byCustomer = new Map();
  for (const call of upstreamCalls) {
    if (!byCustomer.has(call.customerCode)) byCustomer.set(call.customerCode, []);
    byCustomer.get(call.customerCode).push(call.atMs);
  }
  const violations = [];
  for (const [customer, times] of byCustomer) {
    times.sort((a, b) => a - b);
    let early = 0;
    let first = null;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap < ttlMs) {
        early++;
        if (first === null) first = {prev: times[i - 1], next: times[i], gap};
      }
    }
    if (early > 0 && violations.length < MAX_MESSAGES_PER_CHECK) {
      violations.push(`CACHE-1: customer ${customer} reached claims-core ${early} time(s) within ${ttlMs} ms of its previous upstream call (first at ${first.next} ms, ${first.gap} ms after ${first.prev} ms)`);
    }
  }
  return violations;
}

// RATE-1: in every rolling one-second window [t, t + 1000) starting at an
// upstream call, at most maxRequestsPerSecond upstream calls. Incoming
// requests are not counted: only calls that reach claims-core.
function checkRate(upstreamCalls, maxPerSecond) {
  const times = upstreamCalls.map(c => c.atMs).sort((a, b) => a - b);
  let worst = 0;
  let worstStart = 0;
  let end = 0;
  for (let start = 0; start < times.length; start++) {
    if (end < start) end = start;
    while (end < times.length && times[end] < times[start] + WINDOW_MS) end++;
    const count = end - start;
    if (count > worst) { worst = count; worstStart = times[start]; }
  }
  if (worst > maxPerSecond) {
    return [`RATE-1: ${worst} upstream calls to claims-core in the one-second window starting at ${worstStart} ms (limit ${maxPerSecond})`];
  }
  return [];
}

// PRIVACY-1: no log line may contain a forbidden clinical fragment
// (case-insensitive substring match). Other log text is irrelevant.
function checkPrivacy(logs, fragments) {
  const lowered = fragments.map(f => f.toLowerCase());
  const violations = [];
  logs.forEach((line, i) => {
    const text = line.toLowerCase();
    const hits = fragments.filter((_, k) => text.includes(lowered[k]));
    if (hits.length > 0 && violations.length < MAX_MESSAGES_PER_CHECK) {
      violations.push(`PRIVACY-1: logs[${i}] contains forbidden fragment(s) ${hits.map(h => JSON.stringify(h)).join(', ')}`);
    }
  });
  return violations;
}

export function evaluate(observation) {
  let violations;
  try {
    violations = checkEvidence(observation);
    if (violations.length === 0) {
      const req = observation.requirements;
      violations = [
        ...checkCache(observation.upstreamCalls, req.cacheTtlMs),
        ...checkRate(observation.upstreamCalls, req.maxRequestsPerSecond),
        ...checkPrivacy(observation.logs, req.forbiddenLogFragments),
      ];
    }
  } catch (error) {
    violations = [`EVIDENCE: observation could not be evaluated (${error && error.message ? error.message : 'unknown error'})`];
  }
  return {pass: violations.length === 0, violations};
}
