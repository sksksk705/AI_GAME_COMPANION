const { validateAnswer } = require('./core.cjs');

const REASONS = ['new-event', 'goal-change', 'no-change', 'ambiguous', 'duplicate', 'focused-play', 'outside-watch'];
function silentAnswer() {
  return { summary: '', should_speak: false, event_type: 'quiet', event_key: '', focus_busy: false, goal_related: false,
    facts: [], hypotheses: [], missing_information: [], suggestions: [], memory_proposals: [], annotations: [], next_action: '', learning_proposals: [], observed_change: null };
}
function assessmentCandidate(assessment) {
  // This is an internal policy input; it must never be displayed as a reply.
  const { reason, ...fields } = assessment;
  return { ...silentAnswer(), ...fields, summary: assessment.should_speak ? assessment.event_key : '' };
}
function validateAssessment(input, evidence) {
  const keys = ['should_speak', 'event_type', 'event_key', 'focus_busy', 'goal_related', 'reason', 'facts', 'observed_change'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || keys.some(k => !Object.hasOwn(input, k)) || Object.keys(input).some(k => !keys.includes(k)) || !REASONS.includes(input.reason) || !Array.isArray(input.facts) || input.facts.length > 4) throw new Error('발언 판단 형식이 올바르지 않아요.');
  const candidate = validateAnswer(assessmentCandidate(input), evidence);
  if (candidate.should_speak && candidate.event_type === 'quiet') throw new Error('발언과 침묵 판단이 일치하지 않아요.');
  if (candidate.should_speak && !['new-event', 'goal-change'].includes(input.reason)) throw new Error('새 사건의 발언 근거가 필요해요.');
  if (!candidate.should_speak && (candidate.event_type !== 'quiet' || candidate.event_key || candidate.observed_change)) throw new Error('침묵 판단에 발언 사건을 넣을 수 없어요.');
  return Object.fromEntries(keys.map(k => [k, k === 'reason' ? input.reason : candidate[k]]));
}
function assessmentAgreement(answer, assessment) {
  if (!answer.should_speak || answer.event_type === 'quiet') return null;
  if (!assessment.should_speak || answer.event_key !== assessment.event_key || answer.event_type !== assessment.event_type || answer.goal_related !== assessment.goal_related) return 'assessment-changed';
  const fields = ['kind', 'before_evidence_id', 'after_evidence_id', 'before', 'after'];
  if (!!answer.observed_change !== !!assessment.observed_change || fields.some(k => answer.observed_change?.[k] !== assessment.observed_change?.[k])) return 'assessment-changed';
  return null;
}
async function automaticResponse({ assess, generate, admit = () => null }) {
  const judgment = await assess(), assessment = judgment.assessment;
  const suppressed = !assessment.should_speak ? `assessment:${assessment.reason}` : assessment.focus_busy ? 'focused-play' : await admit(assessmentCandidate(assessment));
  if (suppressed) return { ...judgment, assessment, answer: silentAnswer(), suppressed, generated: false };
  const result = await generate(assessment);
  return { ...result, assessment, suppressed: assessmentAgreement(result.answer, assessment), generated: true };
}
module.exports = { REASONS, silentAnswer, assessmentCandidate, validateAssessment, assessmentAgreement, automaticResponse };
