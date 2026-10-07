const AGE_LIMIT = 75000;
const timestamp = frame => Date.parse(frame?.payload?.capturedAt ?? frame?.capturedAt);
const sameCapture = (a, b) => a?.source === 'window' && b?.source === 'window' && a.worldId === b.worldId && !!a.sessionId && a.sessionId === b.sessionId && a.continuity === b.continuity && a.window === b.window && a.size?.width === b.size?.width && a.size?.height === b.size?.height;

function comparisonFrames(frames, now = Date.now()) {
  const after = frames.at(-1), age = now - timestamp(after);
  if (!after || after.source !== 'window' || !(age >= 0 && age < 10000)) return null;
  const before = frames.find(frame => {
    const gap = timestamp(after) - timestamp(frame);
    return gap >= 15000 && gap <= 45000 && sameCapture(frame, after) && !frame.bytes.equals(after.bytes);
  });
  // Different pixels are only a candidate. The model must identify a meaningful game change or stay silent.
  if (!before) return null;
  return [before, after];
}
function automaticAdmission({ settings, source, visible, busy, blocked, lastAnalysis, lastInteraction, nextAutomaticAt = 0, pair, records, goal }, now = Date.now()) {
  if (!settings.autoAnalyze || !settings.analysisConsent || !settings.model || !['together', 'watch'].includes(settings.mode) || source !== 'window' || !visible || busy || blocked) return false;
  if (now < nextAutomaticAt || now - lastAnalysis < settings.analysisInterval * 1000 || now - lastInteraction < 15000) return false;
  if ((settings.mode === 'together' && !pair) || (settings.mode === 'watch' && !goal)) return false;
  const delivered = records.filter(r => r.kind === 'answer' && (!r.payload.automatic || r.payload.delivered));
  if (delivered.some(r => now - Date.parse(r.created_at) < 60000)) return false;
  return delivered.filter(r => r.payload.automatic && now - Date.parse(r.created_at) < 600000).length < 3;
}
function validateChange(input, evidence) {
  if (input == null) return null; // Old records and direct-question fixtures remain readable.
  if (typeof input !== 'object' || Array.isArray(input) || !['progress', 'setback', 'discovery', 'change'].includes(input.kind)) throw new Error('게임 변화의 형식을 확인해주세요.');
  const byId = new Map(evidence.map(frame => [frame.id, frame]));
  const before = byId.get(input.before_evidence_id), after = byId.get(input.after_evidence_id);
  if (!before || !after || before.id === after.id || !(timestamp(before) < timestamp(after))) throw new Error('게임 변화의 전후 화면을 확인할 수 없어요.');
  if (![input.before, input.after].every(value => typeof value === 'string' && value.trim() && value.length <= 1000)) throw new Error('전후 화면에서 읽은 내용이 필요해요.');
  return { kind: input.kind, before_evidence_id: before.id, after_evidence_id: after.id, before: input.before.trim(), after: input.after.trim() };
}
function hasAdvice(answer) { return !!answer.next_action || ['hypotheses', 'suggestions', 'missing_information', 'memory_proposals', 'learning_proposals'].some(key => answer[key]?.length); }
function reactionDecision(answer, { evidence, live, now = Date.now() }) {
  if (answer.event_type !== 'reaction') return 'reaction-only';
  if (hasAdvice(answer)) return 'unsolicited-advice';
  let change;
  try { change = validateChange(answer.observed_change, evidence); } catch { return 'invalid-change'; }
  if (!change) return 'no-observed-change';
  const before = evidence.find(f => f.id === change.before_evidence_id), after = evidence.find(f => f.id === change.after_evidence_id);
  if (!answer.facts.some(f => f.evidence_id === before.id && f.text?.trim()) || !answer.facts.some(f => f.evidence_id === after.id && f.text?.trim())) return 'missing-change-facts';
  const age = now - timestamp(after), liveAge = now - timestamp(live), gap = timestamp(after) - timestamp(before);
  if (!(age >= 0 && age < AGE_LIMIT) || !(liveAge >= 0 && liveAge < 5000) || !(gap >= 15000 && gap <= 45000)) return 'stale-event';
  if (!live?.sessionId || live.source !== 'window' || [before, after].some(f => f.source !== 'window' || f.world_id !== live.worldId || f.payload.sessionId !== live.sessionId || f.payload.continuity !== live.continuity || f.payload.window !== live.window || f.payload.width !== live.size?.width || f.payload.height !== live.size?.height)) return 'capture-changed';
  return null;
}
function nextDelay(interval, silenceCount) { return Math.min(120000, interval * 1000 * 2 ** Math.min(silenceCount, 2)); }
module.exports = { AGE_LIMIT, comparisonFrames, automaticAdmission, validateChange, hasAdvice, reactionDecision, nextDelay };
