const fs = require('node:fs');
const { validateAnswer, gameLabel, conversation, ROUTE_STEPS } = require('./core.cjs');
const { systemPrompt } = require('./prompts.cjs');

const answerSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'should_speak', 'event_type', 'event_key', 'focus_busy', 'goal_related', 'facts', 'hypotheses', 'missing_information', 'suggestions', 'memory_proposals', 'annotations', 'next_action', 'learning_proposals'],
  properties: {
    should_speak: { type: 'boolean' }, focus_busy: { type: 'boolean' }, goal_related: { type: 'boolean' }, event_key: { type: 'string' },
    event_type: { type: 'string', enum: ['quiet', 'reaction', 'help', 'follow_up'] },
    summary: { type: 'string', description: '기본 120자 안팎의 두 문장 대사. 여러 단계 설명은 suggestions로 옮긴다.' }, next_action: { type: 'string', description: '지금 바로 할 행동 하나. 여러 단계나 추가 정보 목록을 요구하지 않는다. 잡담이면 빈 문자열.' },
    ...Object.fromEntries(['hypotheses', 'missing_information', 'suggestions', 'memory_proposals'].map(key => [key, { type: 'array', items: { type: 'string' } }])),
    facts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'evidence_id'], properties: { text: { type: 'string' }, evidence_id: { type: 'string' } } } },
    annotations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['evidence_id', 'x', 'y', 'width', 'height', 'label'], properties: { evidence_id: { type: 'string' }, label: { type: 'string' }, ...Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, { type: 'number' }])) } } },
    learning_proposals: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['title', 'hypothesis', 'action', 'check', 'conditions', 'evidence_ids'], properties: { ...Object.fromEntries(['title', 'hypothesis', 'action', 'check', 'conditions'].map(k => [k, { type: 'string' }])), evidence_ids: { type: 'array', maxItems: 4, items: { type: 'string' } } } } }
  }
};
async function models(signal) {
  const response = await fetch('https://openrouter.ai/api/v1/models', { signal: signal || AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('모델 목록을 가져오지 못했어요. 잠시 후 다시 시도해주세요.');
  const data = await response.json();
  return (data.data || []).filter(m => m.architecture?.input_modalities?.includes('image') && m.supported_parameters?.includes('structured_outputs')).map(m => ({ id: m.id, name: m.name, pricing: m.pricing }));
}
async function analyze({ key, model, world, question, evidence, memories, profile = { name: '동료', style: 'calm', tone: 'casual', preferences: '' }, mode = 'quiet', automatic = false, recent = [], signal, fetchImpl = fetch }) {
  const metadata = evidence.map(f => ({ id: f.id, source: f.source, observed_at: f.payload.capturedAt || null, saved_at: f.created_at, video_time: f.payload.videoTime, width: f.payload.width, height: f.payload.height }));
  const guide = world.state.scenario === 'anno-hops' ? { scope: '기본 게임의 일반 안내 · 버전과 실제 설정은 미확인', current_step: { number: (world.state.step || 0) + 1, ...ROUTE_STEPS[world.state.step || 0] }, steps: ROUTE_STEPS } : null;
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', redirect: 'error', signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1800, response_format: { type: 'json_schema', json_schema: { name: 'companion_answer', strict: true, schema: answerSchema } },
      messages: [
        { role: 'system', content: systemPrompt(profile, !!guide) },
        { role: 'user', content: [
          { type: 'text', text: JSON.stringify({ world: { id: world.id, name: world.name, game: gameLabel(world.game), goal: world.goal, plan: world.state.scenario ? world.state : null, revision: world.revision }, guide, question, automatic, mode, profile, preferences: profile.preferences, now: new Date().toISOString(), conversation: conversation(recent), evidence: metadata, memories: memories.map(r => ({ id: r.id, kind: r.kind, source: r.source, time: r.time || r.created_at, payload: r.payload, unavailable_evidence: r.unavailable_evidence || [] })) }) },
          ...evidence.map(f => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f.file).toString('base64')}` } }))
        ] }
      ] })
  });
  if (!response.ok) {
    const errors = { 401: 'API 키 인증에 실패했어요.', 402: '제공자 잔액을 확인해주세요.', 429: '요청 한도에 도달했어요. 잠시 후 다시 요청해주세요.', 400: '제공자가 AI 요청 형식을 받아들이지 못했어요. 모델과 이미지·답변 형식을 확인해주세요.' };
    throw new Error(errors[response.status] || `제공자 요청이 실패했어요 (${response.status}). 자동으로 재전송하지 않아요.`);
  }
  const body = await response.text();
  if (body.length > 200000) throw new Error('AI 답변 크기가 한도를 넘었어요.');
  const data = JSON.parse(body);
  if (data.error) throw new Error('제공자가 답변을 완료하지 못했어요.');
  const raw = data.choices?.[0]?.message?.content;
  const parsed = JSON.parse(raw);
  const answer = validateAnswer(parsed, evidence);
  if (!automatic && !answer.summary) throw new Error('동료의 답변이 비어 있어요. 다시 이야기해주세요.');
  return { answer, usage: data.usage || null, providerId: data.id || null };
}
module.exports = { models, analyze, answerSchema };
