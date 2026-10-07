const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../src/store.cjs');
const { loadJudgeSuite, judge, runJudgeEvaluation, summary } = require('../scripts/judge-evaluation.cjs');

module.exports = async function checkJudges() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-check-')), store = openStore(directory);
  try {
    const suite = loadJudgeSuite(path.join(__dirname, '../docs/cases/JUDGE_BENCHMARK.example.json'));
    let calls = [];
    const mock = async (url, init) => {
      const body = JSON.parse(init.body); calls.push({ url, body });
      const decisions = url.endsWith('/alpha/decisions');
      const state = decisions ? body.state : JSON.parse(body.messages[1].content);
      const speak = state.observations.game_event?.grounded === true && !state.player.busy && state.observations.readable;
      return new Response(JSON.stringify({ id: 'test-request', model: `${body.model}-test-snapshot`, provider: 'fixture', usage: { cost: .001 }, ...(decisions ? { answers: { should_speak: { type: 'noul', noul: speak ? .9 : .1 } } } : { choices: [{ message: { content: JSON.stringify({ should_speak: speak }) } }] }) }));
    };
    const report = await runJudgeEvaluation({ suite, key: 'fixture-key', store, maxRequests: 20, fetchImpl: mock });
    assert.equal(report.rows.length, 16); assert.equal(report.protocol, 'text-policy-only');
    assert.equal(report.gameAccuracyValidated, false); assert.equal(report.dataSource, 'example-only');
    assert.deepEqual(report.summary.map(s => s.completed), [4, 4, 4, 4]);
    for (const sample of suite.cases) {
      const entries = calls.filter(c => JSON.stringify(c.body.state || JSON.parse(c.body.messages[1].content)) === JSON.stringify(sample.state));
      assert.deepEqual(new Set(entries.map(c => c.body.model)), new Set(suite.models.map(m => m.id)), 'All candidates must receive the complete identical observation packet.');
    }
    assert.equal(calls.some(c => JSON.stringify(c.body).includes('example-author')), false, 'Expected labels must never be sent.');
    const decisionCall = calls.find(c => c.url.endsWith('/alpha/decisions'));
    assert.equal(decisionCall.body.questions.should_speak.type, 'noul');
    assert.equal(decisionCall.body.response_format, undefined);
    const chatCall = calls.find(c => c.url.endsWith('/chat/completions'));
    assert.equal(chatCall.body.response_format.json_schema.strict, true);
    const ledger = store.usageSince('2000-01-01');
    assert.ok(ledger.every(r => r.payload.type === 'judge-evaluation' && r.payload.stage === 'policy'));
    const count = calls.length;
    await assert.rejects(runJudgeEvaluation({ suite, key: 'fixture-key', store, maxRequests: 20, fetchImpl: mock }), /남은 한도/);
    assert.equal(calls.length, count, 'Insufficient suite budget must fail before any paid call.');
    for (const noul of ['0.9', NaN, -1, 1.1]) await assert.rejects(judge({ key: 'fixture', model: suite.models[0], state: {}, threshold: .8, fetchImpl: async () => new Response(JSON.stringify({ answers: { should_speak: { type: 'noul', noul } } })) }), /확률/);
    await assert.rejects(judge({ key: 'fixture', model: suite.models[1], state: {}, threshold: .8, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"should_speak":"yes"}' } }] })) }), /판단 응답/);
    const misses = summary([{ requestedModel: 'fixture', decision: { should_speak: false }, expected: true, timing: { totalMs: 100 } }, { requestedModel: 'fixture', decision: { should_speak: true }, expected: false, timing: { totalMs: 200 }, usage: { cost: .01 } }, { requestedModel: 'fixture', error: 'failed' }], { id: 'fixture' });
    assert.equal(misses.falseSpeech, 1); assert.equal(misses.missedEvent, 1); assert.equal(misses.errors, 1); assert.equal(misses.unknownCostRequests, 2);
    assert.equal(misses.p50Milliseconds, 100); assert.equal(misses.p95Milliseconds, 200);
    const invalid = { ...suite, models: [{ id: 'typesafe/jev-router', api: 'decisions' }] };
    const file = path.join(directory, 'invalid.json'); fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => loadJudgeSuite(file), /API 종류/);
    console.log('PASS: Jev Decisions vs chat transport, identical text state, label exclusion, probability validation, quota preflight, per-model counts and policy-only reporting.');
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
};
