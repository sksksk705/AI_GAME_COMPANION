const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../src/store.cjs');
const { assess, analyze } = require('../src/provider.cjs');
const { automaticResponse, silentAnswer } = require('../src/proactivity.cjs');
const { requestSession } = require('../src/api-session.cjs');
const { recentFrames, boundedContext, CONTEXT_LIMITS } = require('../src/stream-context.cjs');
const { loadSuite, evaluationPlan, runEvaluation } = require('../scripts/companion-evaluation.cjs');

module.exports = async function checkAPICompanion() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-companion-')), store = openStore(directory);
  try {
    const now = Date.now(), at = age => new Date(now - age).toISOString();
    const frame = (age, content, patch = {}) => ({ worldId: 'world', source: 'window', sessionId: 'session', continuity: 1, window: 'test-game', size: { width: 1280, height: 720 }, capturedAt: at(age), bytes: Buffer.from(content), ...patch });
    const latest = frame(1000, 'after'), middle = frame(11000, 'middle'), before = frame(21000, 'before');
    assert.deepEqual(recentFrames([before, middle, latest], now), [before, middle, latest]);
    assert.deepEqual(recentFrames([frame(21000, 'after'), latest], now), [latest], 'Exact duplicates do not consume image slots.');
    for (const patch of [{ continuity: 2 }, { sessionId: 'other' }, { worldId: 'other' }, { source: 'video' }, { window: 'other' }, { size: { width: 1920, height: 1080 } }]) assert.deepEqual(recentFrames([{ ...before, ...patch }, latest], now), [latest]);
    assert.deepEqual(recentFrames([frame(31001, 'old'), latest], now), [latest]);
    assert.deepEqual(recentFrames([frame(10001, 'stale')], now), []);

    const world = store.create('API 최적화 시험', 'Anno 1800', '홉 운송');
    const old = store.frame(world.id, Buffer.from('old-decision-image'), { source: 'video', width: 1280, height: 720, capturedAt: at(300000), videoTime: 3 });
    const decision = store.add(world.id, 'answer', 'model', { question: '북쪽섬은 관광용으로 남겨두자', summary: '그 선택을 기억할게.', evidence: [old.id] });
    for (let n = 0; n < 16; n++) store.add(world.id, 'answer', 'model', { question: `다른 대화 ${n}`, summary: '새 대화' });
    const scenes = [before, middle, latest].map(f => store.frame(world.id, f.bytes, { source: 'window', width: 1280, height: 720, capturedAt: f.capturedAt, sessionId: 'session', continuity: 1, window: 'test-game' }));
    let context = store.analysisContext(world.id, '북쪽섬은 어떻게 하기로 했지?', null, { recentEvidence: scenes });
    assert.deepEqual(context.evidence.map(f => f.id), [...scenes.map(f => f.id), old.id]);
    assert.deepEqual(context.evidence.map(f => f.context_role), ['recent', 'recent', 'current', 'recalled']);
    assert.ok(context.memories.some(m => m.id === decision.id));
    // Expiration is exercised through the public prune path.
    store.db.prepare('UPDATE records SET created_at=? WHERE id=?').run(at(31 * 86400000), old.id);
    store.prune();
    context = store.analysisContext(world.id, '북쪽섬', null, { recentEvidence: scenes });
    assert.equal(context.evidence.some(f => f.id === old.id), false);
    assert.deepEqual(context.memories.find(m => m.id === decision.id).unavailable_evidence, [old.id]);
    const foreign = store.create('다른 월드', 'Factorio', '');
    assert.throws(() => store.analysisContext(foreign.id, '북쪽섬', null, { recentEvidence: scenes }));

    const huge = { id: 'oversized', kind: 'note', source: 'user', payload: { text: '정정과 조건'.repeat(5000) } };
    const short = { id: 'small', kind: 'note', source: 'user', payload: { text: '조건은 미확인' } };
    const turns = Array.from({ length: 12 }, (_, n) => ({ id: String(n), kind: 'answer', source: 'model', created_at: at(n), payload: { question: '질문'.repeat(500), summary: '응답'.repeat(500) } }));
    const bounded = boundedContext([huge, short], turns);
    assert.deepEqual(bounded.memories.map(m => m.id), ['small']);
    assert.equal(bounded.budget.omitted_memories, 1);
    assert.ok(bounded.budget.memory_characters <= CONTEXT_LIMITS.memoryCharacters);
    assert.ok(bounded.budget.dialogue_characters <= CONTEXT_LIMITS.dialogueCharacters);
    assert.ok(bounded.conversation.some(c => c.id === '0'), 'Keep the most recent complete turns.');

    const evidence = [scenes[0], scenes[2]].map(f => store.evidence(world.id, f.id));
    const change = { kind: 'progress', before_evidence_id: evidence[0].id, after_evidence_id: evidence[1].id, before: '시험 재고 0', after: '시험 재고 10' };
    const judgment = { should_speak: true, event_type: 'reaction', event_key: 'test:stock-increased', focus_busy: false, goal_related: false, reason: 'new-event', observed_change: change, facts: evidence.map((f, n) => ({ evidence_id: f.id, text: n ? change.after : change.before })) };
    const reply = { ...silentAnswer(), ...judgment, summary: '시험 응답 · 재고가 늘었네.' }; delete reply.reason;
    let requests = [];
    let nextJudgment = judgment, nextReply = reply;
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      const context = JSON.parse(body.messages[1].content[0].text);
      const content = body.response_format.json_schema.name === 'companion_assessment' ? nextJudgment : context.automatic ? nextReply : { ...silentAnswer(), should_speak: true, event_type: 'help', summary: '시험용 질문 응답', facts: context.evidence.map(f => ({ evidence_id: f.id, text: '시험용 근거' })) };
      return new Response(JSON.stringify({ model: 'fixture-snapshot', id: 'fixture-id', choices: [{ message: { content: JSON.stringify(content) } }], usage: { cost: .001, prompt_tokens: 10, completion_tokens: 10 } }));
    };
    const parameters = { key: 'fixture-key', model: 'fixture-model', world, question: '새 변화만 반응', evidence, memories: [huge, short], recent: turns, automatic: true, mode: 'together', fetchImpl };
    let limit = 200, signal = new AbortController();
    const used = () => store.usageSince('2000-01-01').length;
    const session = () => requestSession({ store, model: parameters.model, type: 'automatic', used, limit: () => limit, signal: signal.signal });
    const respond = async (admit = () => null) => {
      const run = session();
      return automaticResponse({ assess: () => run('assessment', () => assess({ ...parameters, signal: signal.signal })), admit,
        generate: assessment => run('response', () => analyze({ ...parameters, assessment, signal: signal.signal })) });
    };
    const quiet = { ...judgment, should_speak: false, event_type: 'quiet', event_key: '', reason: 'no-change', observed_change: null, facts: [] };
    nextJudgment = quiet;
    let result = await respond();
    assert.equal(requests.length, 1); assert.equal(result.generated, false); assert.equal(result.answer.summary, '');
    assert.equal(result.suppressed, 'assessment:no-change');
    assert.ok(requests[0].max_tokens < 1800);
    const sent = JSON.parse(requests[0].messages[1].content[0].text);
    assert.deepEqual(sent.memories.map(m => m.id), ['small']);
    assert.equal(sent.context_budget.omitted_memories, 1);
    assert.equal(result.contextRefs.memories.includes('oversized'), false);

    requests = []; nextJudgment = judgment;
    result = await respond();
    assert.equal(requests.length, 2); assert.equal(result.generated, true); assert.equal(result.suppressed, null);
    assert.deepEqual(JSON.parse(requests[1].messages[1].content[0].text).assessment.observed_change, change);
    const ledger = store.usageSince('2000-01-01');
    assert.deepEqual(ledger.slice(-2).map(r => r.payload.stage), ['assessment', 'response']);
    assert.equal(ledger.at(-1).payload.sessionId, ledger.at(-2).payload.sessionId);
    assert.equal(ledger.at(-1).payload.model, 'fixture-snapshot');
    assert.equal(typeof ledger.at(-1).payload.timing.totalMs, 'number');

    requests = [];
    result = await respond(() => 'context-changed');
    assert.equal(requests.length, 1); assert.equal(result.generated, false);
    requests = []; nextReply = { ...reply, observed_change: { ...change, after: '시험 재고 1000' } };
    result = await respond();
    assert.equal(result.suppressed, 'assessment-changed');
    nextReply = reply;
    requests = []; limit = used() + 1;
    result = await respond(() => used() >= limit ? 'request-limit' : null);
    assert.equal(requests.length, 1); assert.equal(result.suppressed, 'request-limit');
    await assert.rejects(session()('response', () => analyze(parameters)), /요청 한도/);
    assert.equal(requests.length, 1);
    limit = 200; signal.abort();
    const count = used();
    await assert.rejects(session()('assessment', () => assess(parameters)), /abort/i);
    assert.equal(used(), count); signal = new AbortController();
    requests = []; nextJudgment = { ...judgment, facts: [{ text: '외부 화면', evidence_id: 'not-provided' }] };
    await assert.rejects(respond(), /근거/);
    assert.equal(requests.length, 1); assert.equal(store.usageSince('2000-01-01').at(-1).payload.status, 'unknown');
    nextJudgment = quiet;

    const manifest = { version: 1, cases: [{ id: 'question', kind: 'question', at: at(0), world: { id: world.id, game: 'Anno 1800' }, question: '시험 질문', current_evidence_id: evidence[1].id,
      evidence: evidence.map((f, n) => ({ id: f.id, source: 'window', file: path.relative(directory, f.file), width: 1280, height: 720, captured_at: f.payload.capturedAt, role: n ? 'current' : 'recent' })), memories: [], recent: [], expected: { review: 'DO_NOT_SEND_EXPECTED_TO_MODEL' } }] };
    const manifestFile = path.join(directory, 'suite.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const suite = loadSuite(manifestFile), plan = evaluationPlan(suite);
    assert.equal(plan.maximumRequests, 3); assert.equal(plan.missingEvidence.length, 0);
    requests = [];
    const report = await runEvaluation({ suite, key: 'fixture-key', model: 'fixture-model', store, maxRequests: 200, fetchImpl });
    assert.equal(report.rows.length, 3); assert.equal(report.completedRequests, 3); assert.equal(report.liveWindowDeliveryTested, false);
    assert.deepEqual(requests.map(r => r.messages[1].content.filter(c => c.type === 'image_url').length), [1, 2, 2]);
    assert.equal(requests.some(r => JSON.stringify(r).includes('DO_NOT_SEND_EXPECTED_TO_MODEL')), false);
    const autoManifest = structuredClone(manifest); autoManifest.cases[0].kind = 'automatic'; autoManifest.cases[0].mode = 'together';
    fs.writeFileSync(manifestFile, JSON.stringify(autoManifest)); requests = [];
    const autoReport = await runEvaluation({ suite: loadSuite(manifestFile), key: 'fixture-key', model: 'fixture-model', store, maxRequests: 200, fetchImpl });
    assert.equal(autoReport.completedRequests, 2); assert.equal(autoReport.rows.at(-1).suppressed, 'assessment:no-change');
    requests = []; nextJudgment = judgment;
    const limited = await runEvaluation({ suite: loadSuite(manifestFile), key: 'fixture-key', model: 'fixture-model', store, maxRequests: used() + 2, fetchImpl });
    assert.equal(limited.stopped, 'request-limit'); assert.equal(requests.length, 2);
    const futureManifest = structuredClone(manifest); futureManifest.cases[0].evidence[0].captured_at = new Date(now + 1000).toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(futureManifest)); assert.throws(() => loadSuite(manifestFile), /미래/);
    const futureCorrection = structuredClone(manifest);
    futureCorrection.cases[0].memories = [{ id: 'late-correction', kind: 'experience', source: 'user', time: at(10000), payload: { history: [{ at: new Date(now + 1000).toISOString(), status: 'completed' }] } }];
    fs.writeFileSync(manifestFile, JSON.stringify(futureCorrection)); assert.throws(() => loadSuite(manifestFile), /미래/);
    delete futureCorrection.cases[0].memories[0].time; futureCorrection.cases[0].memories[0].payload.history = [];
    fs.writeFileSync(manifestFile, JSON.stringify(futureCorrection)); assert.throws(() => loadSuite(manifestFile), /시점/);
    const reversed = structuredClone(manifest); reversed.cases[0].kind = 'automatic'; reversed.cases[0].mode = 'together'; reversed.cases[0].evidence.reverse();
    fs.writeFileSync(manifestFile, JSON.stringify(reversed)); assert.throws(() => loadSuite(manifestFile), /시간순/);
    const template = loadSuite(path.join(__dirname, '../docs/cases/API_BENCHMARK.example.json'));
    assert.equal(evaluationPlan(template).maximumRequests, 6);
    console.log('PASS: API assessment/response separation, per-stage quota/cancellation/usage, event agreement, bounded context, recent scene isolation, recalled answer images, and causal replay comparisons.');
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
};
