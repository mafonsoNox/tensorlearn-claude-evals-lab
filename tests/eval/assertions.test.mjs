import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {evaluate} from '../../evals/assert.mjs';
import {observe as good} from '../../references/good.mjs';
import {observe as broken} from '../../references/broken.mjs';

const workload = JSON.parse(readFileSync(new URL('../../fixtures/workload.json', import.meta.url), 'utf8'));
const requirements = () => ({maxRequestsPerSecond: 50, cacheTtlMs: 30000, forbiddenLogFragments: ['clinicalPayload', 'diagnosis', 'glucose']});

// Build an observation directly from upstream call times, so each test states
// exactly the behaviour it exercises.
function observation({requests, upstreamCalls, logs = ['request batch completed']}) {
  return {
    requests,
    upstreamCalls,
    responses: requests.map(r => ({customerCode: r.customerCode, status: 'ok'})),
    logs,
    requirements: requirements(),
  };
}
const call = (customerCode, atMs) => ({customerCode, atMs});

function assertPass(result) {
  assert.deepEqual(Object.keys(result).sort(), ['pass', 'violations']);
  assert.equal(result.pass, true, result.violations.join('\n'));
  assert.deepEqual(result.violations, []);
}
function assertFail(result, requirementId) {
  assert.deepEqual(Object.keys(result).sort(), ['pass', 'violations']);
  assert.equal(result.pass, false);
  assert.ok(result.violations.length > 0);
  assert.ok(result.violations.every(v => typeof v === 'string' && v.length > 0));
  if (requirementId) assert.ok(result.violations.some(v => v.startsWith(requirementId)), result.violations.join('\n'));
}

// --- References on the repeatable workload -------------------------------

test('good reference passes on the workload', () => {
  assertPass(evaluate(good(workload)));
});

test('broken reference (cache removed) fails CACHE-1 and RATE-1', () => {
  const result = evaluate(broken(workload));
  assertFail(result, 'CACHE-1');
  assertFail(result, 'RATE-1');
});

// --- Valid refactors must pass --------------------------------------------

test('valid refactor: different harmless log text and response status', () => {
  const obs = good(workload);
  obs.logs = ['all requests completed successfully with version 2', 'cache hit ratio 59/60'];
  obs.responses = obs.responses.map(r => ({...r, status: 'fresh'}));
  assertPass(evaluate(obs));
});

test('valid refactor: interleaved customers each cached separately, refresh at exactly 30000 ms', () => {
  const requests = [];
  for (let t = 0; t <= 60000; t += 500) requests.push(call('CUS-A', t), call('CUS-B', t + 1));
  const upstreamCalls = [call('CUS-A', 0), call('CUS-B', 1), call('CUS-A', 30000), call('CUS-B', 30001), call('CUS-A', 60000), call('CUS-B', 60001)];
  assertPass(evaluate(observation({requests, upstreamCalls})));
});

test('valid refactor: upstream calls recorded out of order are still judged by time', () => {
  const requests = [call('CUS-A', 0), call('CUS-A', 30000)];
  assertPass(evaluate(observation({requests, upstreamCalls: [call('CUS-A', 30000), call('CUS-A', 0)]})));
});

test('RATE-1 counts upstream calls, not requests: 60 requests with one upstream call pass', () => {
  const requests = Array.from({length: 60}, (_, i) => call('CUS-A', i * 10));
  assertPass(evaluate(observation({requests, upstreamCalls: [call('CUS-A', 0)]})));
});

test('RATE-1 boundary: 50 different customers within one second pass', () => {
  const calls = Array.from({length: 50}, (_, i) => call(`CUS-${i}`, i * 10));
  assertPass(evaluate(observation({requests: calls, upstreamCalls: calls})));
});

test('RATE-1 window is one second: 51 calls spread over just over one second pass', () => {
  const calls = Array.from({length: 51}, (_, i) => call(`CUS-${i}`, i * 20)); // 0..1000 ms
  assertPass(evaluate(observation({requests: calls, upstreamCalls: calls})));
});

// --- Failure variants must be caught --------------------------------------

test('missing cache at low traffic: same customer refetched after 5 s fails CACHE-1 only', () => {
  const requests = [call('CUS-A', 0), call('CUS-A', 5000)];
  const result = evaluate(observation({requests, upstreamCalls: requests}));
  assertFail(result, 'CACHE-1');
  assert.ok(!result.violations.some(v => v.startsWith('RATE-1')));
});

test('CACHE-1 boundary: refresh at 29999 ms fails', () => {
  const requests = [call('CUS-A', 0), call('CUS-A', 29999)];
  assertFail(evaluate(observation({requests, upstreamCalls: requests})), 'CACHE-1');
});

test('rate-limit breach: 51 different customers within one second fail RATE-1 only', () => {
  const calls = Array.from({length: 51}, (_, i) => call(`CUS-${i}`, i * 19)); // 0..950 ms
  const result = evaluate(observation({requests: calls, upstreamCalls: calls}));
  assertFail(result, 'RATE-1');
  assert.ok(!result.violations.some(v => v.startsWith('CACHE-1')));
});

test('rate-limit breach in a later rolling window is caught', () => {
  const calls = [call('CUS-early', 0), ...Array.from({length: 51}, (_, i) => call(`CUS-${i}`, 5500 + i * 10))];
  assertFail(evaluate(observation({requests: calls, upstreamCalls: calls})), 'RATE-1');
});

test('clinical payload in a log line fails PRIVACY-1', () => {
  const obs = good(workload);
  obs.logs = ['request batch completed', 'status for CUS-000123 clinicalPayload={"glucose":7.1}'];
  assertFail(evaluate(obs), 'PRIVACY-1');
});

test('forbidden fragment embedded mid-line or in different case fails PRIVACY-1', () => {
  const obs = good(workload);
  obs.logs = ['customer record: Diagnosis=E11'];
  assertFail(evaluate(obs), 'PRIVACY-1');
});

// --- Malformed or insufficient evidence must fail -------------------------

test('empty or malformed observations fail with a violation', () => {
  const missingRequirements = good(workload);
  delete missingRequirements.requirements;
  const badCall = good(workload);
  badCall.upstreamCalls = [{customerCode: 'CUS-000123'}];
  const badLog = good(workload);
  badLog.logs = [42];
  const noRequests = observation({requests: [], upstreamCalls: []});
  for (const input of [undefined, null, 'x', [], {}, missingRequirements, badCall, badLog, noRequests]) {
    assertFail(evaluate(input), 'EVIDENCE');
  }
});

test('evaluate does not modify the observation it is given', () => {
  const obs = observation({requests: [call('CUS-B', 50), call('CUS-A', 0)], upstreamCalls: [call('CUS-B', 50), call('CUS-A', 0)]});
  const before = JSON.stringify(obs);
  evaluate(obs);
  assert.equal(JSON.stringify(obs), before);
});
