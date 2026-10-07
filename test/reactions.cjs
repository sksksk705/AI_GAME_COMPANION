const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { comparisonFrames, automaticAdmission, validateChange, reactionDecision, nextDelay } = require('../src/reactions.cjs');
const { validateAnswer, proactiveDecision, conversation } = require('../src/core.cjs');
const { analyze } = require('../src/provider.cjs');
const { openStore } = require('../src/store.cjs');

module.exports = async function checkReactions() {
  const now = Date.now(), frame = (age, pixels) => ({ bytes: Buffer.from(pixels), source: 'window', capturedAt: new Date(now - age).toISOString(), worldId: 'world', sessionId: 'session', continuity: 1, window: 'Fixture game', size: { width: 1280, height: 720 }, signature: [20, 30] });
  const before = frame(65000, 'before'), after = frame(45000, 'after'), live = frame(1000, 'after');
  const recentBefore = frame(21000, 'before'), recentAfter = frame(1000, 'after');
  assert.deepEqual(comparisonFrames([recentBefore, recentAfter], now), [recentBefore, recentAfter]);
  const earlierChange = frame(44000, 'before');
  assert.deepEqual(comparisonFrames([earlierChange, frame(21000, 'after'), recentAfter], now), [earlierChange, recentAfter], 'a stable finished result can still be compared with the earlier changed frame');
  for (const patch of [{ sessionId: 'other' }, { continuity: 2 }, { source: 'video' }, { worldId: 'other' }, { window: 'other' }, { size: { width: 1920, height: 1080 } }, { bytes: Buffer.from('after') }]) assert.equal(comparisonFrames([{ ...recentBefore, ...patch }, recentAfter], now), null);
  assert.equal(comparisonFrames([frame(14000, 'before'), recentAfter], now), null);
  assert.equal(comparisonFrames([recentBefore, frame(10000, 'after')], now), null);

  const asEvidence = (id, value) => ({ id, source: value.source, world_id: value.worldId, payload: { capturedAt: value.capturedAt, sessionId: value.sessionId, continuity: value.continuity, window: value.window, width: value.size.width, height: value.size.height } });
  const evidence = [asEvidence('before', before), asEvidence('after', after)];
  const change = { kind: 'progress', before_evidence_id: 'before', after_evidence_id: 'after', before: '시험용 재고 0', after: '시험용 재고 10' };
  const candidate = { summary: 'UI 시험용 · 오, 기록 화면에서 재고가 늘었네.', should_speak: true, event_type: 'reaction', event_key: 'fixture:inventory-increased', focus_busy: false, goal_related: false, facts: [{ text: change.before, evidence_id: 'before' }, { text: change.after, evidence_id: 'after' }], hypotheses: [], missing_information: [], suggestions: [], memory_proposals: [], annotations: [], next_action: '', learning_proposals: [], observed_change: change };
  assert.deepEqual(validateAnswer(candidate, evidence).observed_change, change);
  for (const patch of [{ after_evidence_id: 'missing' }, { before_evidence_id: 'after' }, { before_evidence_id: 'after', after_evidence_id: 'before' }, { before: '' }, { kind: 'made-up' }]) assert.throws(() => validateChange({ ...change, ...patch }, evidence));
  const policy = { mode: 'together', sampleStable: true, evidence, live, records: [], now };
  assert.equal(proactiveDecision(candidate, policy), null, '45-second response can react to a recorded event; it does not prove the current state');
  assert.equal(proactiveDecision(candidate, { ...policy, mode: 'quiet' }), 'quiet-mode');
  assert.equal(proactiveDecision({ ...candidate, focus_busy: true }, policy), 'focused-play');
  assert.equal(proactiveDecision(candidate, { ...policy, sampleStable: false }), 'scene-changed');
  for (const patch of [{ event_type: 'help' }, { next_action: '건물을 더 지어' }, { suggestions: ['조언'] }, { missing_information: ['질문'] }, { learning_proposals: [{ title: '시도' }] }]) assert.ok(reactionDecision({ ...candidate, ...patch }, policy));
  assert.equal(reactionDecision({ ...candidate, summary: '필요하면 불러줘.', observed_change: null }, policy), 'no-observed-change');
  assert.equal(reactionDecision({ ...candidate, facts: candidate.facts.slice(1) }, policy), 'missing-change-facts');
  for (const patch of [{ sessionId: 'other' }, { continuity: 2 }, { source: 'video' }, { worldId: 'other' }, { window: 'other' }, { size: { width: 1920, height: 1080 } }]) assert.equal(reactionDecision(candidate, { ...policy, live: { ...live, ...patch } }), 'capture-changed');
  assert.equal(reactionDecision(candidate, { ...policy, live: frame(5000, 'after') }), 'stale-event');
  assert.equal(reactionDecision(candidate, { ...policy, now: now + 30000, live: { ...live, capturedAt: new Date(now + 29000).toISOString() } }), 'stale-event');
  assert.equal(reactionDecision(candidate, { ...policy, evidence: evidence.map(f => ({ ...f, source: 'video' })) }), 'capture-changed');
  const delivered = (age, payload = {}) => ({ kind: 'answer', created_at: new Date(now - age).toISOString(), payload: { automatic: true, delivered: true, ...payload } });
  assert.equal(proactiveDecision(candidate, { ...policy, records: [delivered(30000)] }), 'cooldown');
  assert.equal(proactiveDecision(candidate, { ...policy, records: [delivered(90000, { event_key: candidate.event_key })] }), 'duplicate');
  assert.equal(proactiveDecision(candidate, { ...policy, records: [90000, 180000, 270000].map(age => delivered(age)) }), 'frequency-limit');

  const admission = { settings: { mode: 'together', autoAnalyze: true, analysisConsent: true, model: 'fixture-model', analysisInterval: 30 }, source: 'window', visible: true, busy: false, blocked: false, lastAnalysis: now - 31000, lastInteraction: now - 16000, pair: [recentBefore, recentAfter], records: [], goal: '' };
  assert.equal(automaticAdmission(admission, now), true);
  for (const patch of [{ source: 'video' }, { visible: false }, { busy: true }, { blocked: true }, { pair: null }, { nextAutomaticAt: now + 1 }, { lastInteraction: now - 14000 }, { lastAnalysis: now - 29000 }, { records: [delivered(30000)] }, { records: [90000, 180000, 270000].map(age => delivered(age)) }]) assert.equal(automaticAdmission({ ...admission, ...patch }, now), false);
  for (const patch of [{ mode: 'quiet' }, { autoAnalyze: false }, { analysisConsent: false }, { model: '' }]) assert.equal(automaticAdmission({ ...admission, settings: { ...admission.settings, ...patch } }, now), false);
  assert.equal(automaticAdmission({ ...admission, settings: { ...admission.settings, mode: 'watch' }, pair: null, goal: '명시한 목표' }, now), true);
  assert.equal(automaticAdmission({ ...admission, settings: { ...admission.settings, mode: 'watch' }, pair: null, goal: '' }, now), false);
  assert.deepEqual([0, 1, 2, 10].map(count => nextDelay(30, count)), [30000, 60000, 120000, 120000]);

  // Exercise the real SQLite + provider request path, including chronological image roles and stored references.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reaction-check-')), store = openStore(directory);
  try {
    const world = store.create('시험용 게임 반응', 'Factorio', '');
    const saved = [before, after].map(f => store.frame(world.id, f.bytes, { source: 'window', capturedAt: f.capturedAt, sessionId: f.sessionId, continuity: f.continuity, window: f.window, width: f.size.width, height: f.size.height }));
    const images = saved.map(f => store.evidence(world.id, f.id));
    const answer = { ...candidate, observed_change: { ...change, before_evidence_id: saved[0].id, after_evidence_id: saved[1].id }, facts: saved.map((f, i) => ({ evidence_id: f.id, text: i ? change.after : change.before })) };
    let count = 0;
    const result = await analyze({ key: 'fixture-key', model: 'fixture-model', world, question: '시험용 변화 반응', evidence: images, memories: [], automatic: true, mode: 'together', signal: new AbortController().signal, fetchImpl: async (_url, init) => {
      count++;
      const request = JSON.parse(init.body), context = JSON.parse(request.messages[1].content[0].text);
      assert.deepEqual(context.evidence.map(f => f.comparison_role), ['before', 'after']);
      assert.deepEqual(context.evidence.map(f => f.observed_at), [before.capturedAt, after.capturedAt]);
      assert.equal(request.messages[1].content.filter(item => item.type === 'image_url').length, 2);
      assert.match(request.messages[0].content, /인사·부르라는 안내·정기 체크인·조언/);
      assert.equal(request.response_format.json_schema.schema.properties.observed_change.type.includes('null'), true);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    } });
    assert.equal(count, 1);
    assert.equal(proactiveDecision(result.answer, { ...policy, evidence: images, live: { ...live, worldId: world.id } }), null);
    const record = store.saveAnswer(world.id, 'model', { ...result.answer, automatic: true, delivered: true, reaction_observed_at: after.capturedAt, evidence: saved.map(f => f.id) });
    assert.equal(record.payload.experience_ids.length, 0, 'an automatic reaction does not create unsolicited work');
    assert.equal(store.context(world.id).some(r => r.id === record.id), true);
    assert.equal(conversation(store.context(world.id))[0].observed_at, after.capturedAt);
    assert.equal(store.promptContext(world.id, '재고').memories.find(r => r.id === record.id).payload.observed_at, after.capturedAt);
    for (let i = 0; i < 110; i++) store.add(world.id, 'frame', 'window', { filename: `fixture-${i}.jpg` });
    assert.equal(store.snapshotRecords(world.id).filter(r => saved.some(f => f.id === r.id)).length, 2);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('PASS: grounded game reactions, two-frame continuity, 45-second recorded-event delivery, advice/greeting-only rejection, stale/session/gap/focus/cooldown guards, paid-request admission/backoff and SQLite/provider context.');
};
