const EXPERIENCE_STATES = { proposed: '함께 해볼 제안', accepted: '해보기로 했어요', applied: '적용 · 결과 기다리는 중', completed: '결과를 남겼어요', deferred: '나중에 다시 보기', rejected: '이번에는 하지 않기' };
const EXPERIENCE_TRANSITIONS = { proposed: ['accepted', 'deferred', 'rejected'], accepted: ['applied', 'deferred', 'rejected'], applied: ['completed', 'deferred'], completed: [], deferred: ['accepted', 'rejected'], rejected: [] };
const OUTCOMES = { inconclusive: '효과 미확인', improved: '개선 관찰', unchanged: '변화 없음', worse: '악화 관찰' };
const LIMITS = { title: 150, hypothesis: 1000, action: 1000, check: 1000, conditions: 1000, result: 2000, note: 1000 };

function field(value, key, required = false) {
  if (typeof value !== 'string') throw new Error('경험 내용은 글로 입력해주세요.');
  const result = value.trim().slice(0, LIMITS[key] || 1000);
  if (required && !result) throw new Error('제목·시도할 내용·확인 방법을 입력해주세요.');
  return result;
}
function validateProposal(value, evidenceIds) {
  const keys = ['title', 'hypothesis', 'action', 'check', 'conditions', 'evidence_ids'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('학습 제안 형식이 올바르지 않아요.');
  const result = Object.fromEntries(keys.slice(0, 5).map(k => [k, field(value[k] ?? '', k, ['title', 'action', 'check'].includes(k))]));
  if (!Array.isArray(value.evidence_ids) || value.evidence_ids.length > 4 || value.evidence_ids.some(id => typeof id !== 'string' || !evidenceIds.has(id))) throw new Error('학습 제안의 화면 근거를 확인할 수 없어요.');
  result.evidence_ids = [...new Set(value.evidence_ids)];
  return result;
}
function validateProposals(values, evidence) {
  if (values === undefined) return []; // Old saved answers and replay fixtures remain readable.
  if (!Array.isArray(values) || values.length > 2) throw new Error('함께 시도할 제안은 최대 두 개까지 가능해요.');
  const ids = new Set(evidence.map(f => f.id));
  return values.map(value => validateProposal(value, ids));
}
function queryTerms(query) {
  const words = String(query).match(/[\p{L}\p{N}_-]+/gu) || [];
  const terms = words.slice(0, 8).flatMap(word => {
    const stem = word.length > 2 ? word.replace(/(?:에서는|에서|으로|에게|처럼|하고|랑|은|는|을|를|이|가|의|도|에)$/, '') : word;
    return stem.length >= 2 && stem !== word ? [word, stem] : [word];
  });
  return [...new Set(terms)].slice(0, 12);
}
function frameRefs(record) {
  const p = record.payload;
  return [...new Set([...(p.evidence || []), ...(p.before_evidence || []), ...(p.after_evidence || []), ...(p.facts || []).map(f => f.evidence_id), ...(p.annotations || []).map(a => a.evidence_id)])];
}
function memoryForModel(record, unavailable) {
  const { id, kind, source, created_at: time, payload: p } = record;
  let payload = p;
  if (kind === 'answer') payload = { question: p.question || null, question_source: 'user', reply: p.summary || '', reply_source: source, observed_at: p.reaction_observed_at || null, evidence: frameRefs(record) };
  if (kind === 'experience') payload = { title: p.title, hypothesis: p.hypothesis, action: p.action, check: p.check, conditions: p.conditions, status: p.status, outcome: p.outcome, result: p.result, result_source: p.result_source || null, note: p.note, needs_review: !!p.needs_review, history: p.history, before_evidence: p.before_evidence, after_evidence: p.after_evidence, evidence: frameRefs(record) };
  return { id, kind, source, time, payload, unavailable_evidence: frameRefs(record).filter(unavailable) };
}
module.exports = { EXPERIENCE_STATES, EXPERIENCE_TRANSITIONS, OUTCOMES, LIMITS, field, validateProposal, validateProposals, queryTerms, frameRefs, memoryForModel };
