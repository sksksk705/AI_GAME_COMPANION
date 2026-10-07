// Offline replay comparisons. No API call is made by this script's standalone CLI.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const provider = require('../src/provider.cjs');
const { automaticResponse } = require('../src/proactivity.cjs');
const { requestSession } = require('../src/api-session.cjs');

function loadSuite(file) {
  const absolute = path.resolve(file), raw = fs.readFileSync(absolute, 'utf8');
  if (raw.length > 300000) throw new Error('평가 파일이 너무 커요.');
  const suite = JSON.parse(raw), ids = new Set();
  if (suite.version !== 1 || !Array.isArray(suite.cases) || !suite.cases.length || suite.cases.length > 30) throw new Error('version=1과 1~30개의 평가 사례가 필요해요.');
  const cases = suite.cases.map(sample => {
    const at = Date.parse(sample.at);
    if (typeof sample.id !== 'string' || !sample.id || ids.has(sample.id) || !Number.isFinite(at) || !['question', 'automatic'].includes(sample.kind) || typeof sample.question !== 'string' || !sample.world?.game || !Array.isArray(sample.evidence) || sample.evidence.length > 4) throw new Error('평가 사례의 ID·시점·입력 형식을 확인해주세요.');
    ids.add(sample.id);
    if (sample.kind === 'automatic' && !['together', 'watch'].includes(sample.mode)) throw new Error('자동 반응 평가에는 together/watch 모드가 필요해요.');
    const frameIds = new Set();
    const evidence = sample.evidence.map(f => {
      if (typeof f.id !== 'string' || !f.id || frameIds.has(f.id) || !['window', 'video'].includes(f.source) || typeof f.file !== 'string' || !/\.jpe?g$/i.test(f.file) || !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.width > 1920 || f.height < 1 || f.height > 1080 || !Number.isFinite(Date.parse(f.captured_at)) || Date.parse(f.captured_at) > at) throw new Error('근거 이미지의 ID·크기·시점·경로를 확인해주세요. 미래 화면은 사용할 수 없어요.');
      frameIds.add(f.id);
      return { id: f.id, source: f.source, created_at: f.captured_at, context_role: f.role || 'record', file: path.resolve(path.dirname(absolute), f.file), payload: { width: f.width, height: f.height, capturedAt: f.captured_at, videoTime: f.video_time ?? null } };
    });
    if (evidence.length && !frameIds.has(sample.current_evidence_id)) throw new Error('current_evidence_id는 사례의 기준 화면 ID여야 해요.');
    if (sample.kind === 'automatic' && sample.mode === 'together' && (evidence.length !== 2 || sample.current_evidence_id !== evidence[1].id || !(Date.parse(evidence[0].payload.capturedAt) < Date.parse(evidence[1].payload.capturedAt)))) throw new Error('함께 플레이 평가는 시간순으로 정렬된 전후 화면 두 장이 필요해요.');
    for (const record of [...(sample.memories || []), ...(sample.recent || [])]) {
      const times = [record.time || record.created_at, record.updated_at, record.payload?.updated_at, record.payload?.editedAt, ...(record.payload?.history || []).map(h => h.at)].filter(t => t !== undefined);
      if (!record.id || !record.payload || !Number.isFinite(Date.parse(record.time || record.created_at)) || times.some(t => !Number.isFinite(Date.parse(t)) || Date.parse(t) > at) || (record.world_id && record.world_id !== (sample.world.id || sample.id))) throw new Error('기억·대화의 출처와 시점을 확인해주세요. 다른 월드나 미래 기록은 사용할 수 없어요.');
    }
    return { ...sample, evidence, memories: sample.memories || [], recent: sample.recent || [], world: { goal: '', revision: 1, ...sample.world, id: sample.world.id || sample.id, state: { scenario: null, ...sample.world.state } } };
  });
  return { version: 1, file: absolute, cases };
}

function evaluationPlan(suite) {
  const rows = suite.cases.flatMap(sample => (sample.kind === 'question' ? ['current', 'recent', 'memory'] : ['single', 'gated']).map(variant => ({ sample, variant })));
  return { rows, maximumRequests: rows.reduce((n, r) => n + (r.variant === 'gated' ? 2 : 1), 0), missingEvidence: [...new Set(suite.cases.flatMap(s => s.evidence).filter(f => !fs.existsSync(f.file)).map(f => f.file))] };
}

async function runEvaluation({ suite, model, key, store, maxRequests, profile, fetchImpl }) {
  const plan = evaluationPlan(suite);
  if (plan.missingEvidence.length) throw new Error('평가 이미지가 없어요. 실제 플레이 근거를 준비해주세요.');
  for (const frame of suite.cases.flatMap(s => s.evidence)) if (fs.statSync(frame.file).size > 2100000) throw new Error('평가 이미지 한 장은 2.1MB 이하여야 해요.');
  const report = { version: 1, protocol: 'offline-replay', model, date: new Date().toISOString(), maximumRequests: plan.maximumRequests, liveWindowDeliveryTested: false, rows: [] };
  const used = () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    return store.usageSince(new Date(`${today}T00:00:00+09:00`).toISOString()).length;
  };
  for (const { sample, variant } of plan.rows) {
    if (used() >= maxRequests) { report.stopped = 'request-limit'; break; }
    const started = performance.now(), stages = [];
    const signal = AbortSignal.timeout(60000);
    const run = requestSession({ store, model, type: 'companion-evaluation', used, limit: () => maxRequests, signal });
    const current = sample.evidence.find(f => f.id === sample.current_evidence_id);
    const parameters = { key, model, world: sample.world, question: sample.question,
      evidence: variant === 'current' ? (current ? [current] : []) : sample.evidence,
      memories: ['current', 'recent'].includes(variant) ? [] : sample.memories,
      recent: variant === 'current' ? [] : sample.recent,
      automatic: sample.kind === 'automatic', mode: sample.mode || 'quiet', profile, signal, fetchImpl,
      now: sample.at };
    const call = (stage, assessment) => run(stage, async () => {
      const result = await (stage === 'assessment' ? provider.assess(parameters) : provider.analyze({ ...parameters, assessment }));
      stages.push({ stage, usage: result.usage, timing: result.timing, inputStats: result.inputStats, providerId: result.providerId, model: result.model });
      return result;
    });
    try {
      // Compare content/decision protocols; actual app freshness/focus guards are tested separately.
      const result = variant === 'gated' ? await automaticResponse({ assess: () => call('assessment'), admit: () => used() >= maxRequests ? 'request-limit' : null, generate: assessment => call('response', assessment) }) : await call('response');
      report.rows.push({ case: sample.id, variant, at: sample.at, milliseconds: Math.round(performance.now() - started), answer: result.answer, assessment: result.assessment || null, suppressed: result.suppressed || null, stages, expected: sample.expected || null, humanReview: null });
      if (result.suppressed === 'request-limit') { report.stopped = 'request-limit'; break; }
    } catch (error) {
      report.rows.push({ case: sample.id, variant, stages, error: String(error.message).replace(/sk-or-[a-zA-Z0-9-]+/g, '[redacted]').slice(0, 300), humanReview: null });
      report.stopped = signal.aborted ? 'cancelled-or-timeout' : 'request-failed'; break;
    }
  }
  const calls = report.rows.flatMap(r => r.stages);
  const costs = calls.map(s => s.usage?.cost).filter(c => typeof c === 'number' && Number.isFinite(c));
  report.completedRequests = calls.length;
  report.reportedCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  report.unknownCostRequests = calls.length - costs.length + report.rows.filter(r => r.error).length;
  return report;
}

function printPlan(file) {
  const suite = loadSuite(file), plan = evaluationPlan(suite);
  console.log(JSON.stringify({ protocol: 'offline-replay', paidRequestsSent: 0, comparisons: plan.rows.map(r => ({ case: r.sample.id, variant: r.variant })), maximumRequests: plan.maximumRequests, missingEvidence: plan.missingEvidence, run: '앱을 닫고 npm run evaluate -- --live --companion <manifest.json>' }, null, 2));
}
if (require.main === module) {
  try {
    const index = process.argv.indexOf('--manifest');
    if (index < 0 || !process.argv[index + 1]) console.log('API 평가 계획만 확인: npm run benchmark -- --manifest <manifest.json>');
    else printPlan(process.argv[index + 1]);
  } catch { console.error('평가 파일을 읽지 못했어요. JSON 형식과 시점을 확인해주세요.'); process.exitCode = 1; }
}
module.exports = { loadSuite, evaluationPlan, runEvaluation, printPlan };
