const ROUTE_STEPS = [
  { title: '먼저 섬을 준비해요', lead: '돈과 물품은 이동 방식이 달라요.', items: ['자금은 같은 플레이어의 섬에서 공유돼요. 돈을 화물로 보낼 필요는 없어요.', '목재·벽돌·강철 등 필요한 건설 재료는 메인섬에서 배에 싣고 홉 섬에 내려요. 처음에는 수동 운송이면 충분해요.', '홉 비옥도, 농장의 요구 노동력, 밭, 도로와 창고 연결을 확인해요. 노동력은 기본적으로 섬별로 확보하며, 통근 부두 등 공유 기능은 별도예요.'], next: '홉 섬의 농장과 항구를 확인해주세요.' },
  { title: '두 섬을 항로에 추가해요', lead: '기본 단축키 T로 무역로 관리 화면부터 열어요.', items: ['교역소의 “무역 옵션 선택”은 구매·판매 설정이에요. 그 팝업에서 메인섬 목적지를 고르는 방식은 아니에요.', '게임에서 기본 단축키 T를 누르거나 미니맵 아래의 배·화살표 모양 무역로 아이콘을 눌러요. 키를 바꿨다면 게임의 단축키 설정에서 확인해요.', '새 일반 무역로를 선택하고 홉 섬과 메인섬의 항구를 정박지로 추가해요. 두 섬을 모두 소유했다면 자기 재고를 옮기는 운송이에요.'], next: '게임에서 기본 단축키 T를 눌러 무역로 화면을 열어주세요. 키를 바꿨다면 미니맵 아래 배·화살표 아이콘을 이용해요.' },
  { title: '운송할 배를 배정해요', lead: '운송 가능한 보유 선박을 선택해요.', items: ['현재 사용 가능한 선박의 화물칸을 확인하고 항로에 배정해요.', '가까운 두 섬의 소규모 공급은 한 척부터 시험할 수 있어요. 필요한 총 척수는 아직 미확인이에요.', '다른 항로·원정에 쓰는 배인지, 기존 화물이 적재를 막는지 확인해요.'], next: '배의 화물칸과 홉에 쓸 칸 수를 확인해주세요.' },
  { title: '홉을 싣고 내려요', lead: '홉 섬에서는 적재, 메인섬에서는 하역으로 설정해요.', items: ['같은 화물칸에서 홉 섬은 홉 적재, 메인섬은 홉 하역을 설정해요.', '양쪽 수량을 맞춰요. 수량은 배의 실제 적재량과 재고를 확인해 정해요.', '처음에는 가득 찰 때까지 기다리는 옵션을 끄고 준비된 물량부터 옮겨요.'], next: '두 항구의 적재·하역 설정을 확인해주세요.' },
  { title: '돌아오는 물품을 정해요', lead: '홉 섬에서 부족한 생활물품만 추가해요.', items: ['메인섬 → 홉 섬에는 그 섬 주민에게 부족한 생활물품을 보내요. 생선·작업복·슈냅스 등은 주민 단계와 현지 생산에 따라 골라요.', '건설 재료는 초기·확장 때 수동 운송하고, 반복 수요가 확인되면 정기 노선을 검토해요.', '초보 단계에서는 물품별로 화물칸을 나눠요. 남은 다른 화물이 다음 적재를 막을 수 있어요.'], next: '홉 섬 주민의 부족 물품을 하나씩 확인해주세요.' },
  { title: '실제로 움직이는지 확인해요', lead: '설정 완료와 공급 안정은 따로 확인해요.', items: ['항로를 시작하고 배가 출발해 홉을 적재·하역하는지 확인해요.', '홉 섬에 쌓이는데 메인섬에서 부족하면 운송량·항로·하역 상태를 확인해요.', '생산량 자체가 소비량보다 적다면 배를 늘리기 전에 생산·노동력·연결을 확인해요. 여러 왕복 동안 재고 흐름을 살펴봐요.'], next: '설정했다면 “적용했어요”로 기록하고 다음 왕복을 확인해요.' }
];

const PLAN_STATES = { proposed: '제안', accepted: '수락', applied: '적용 · 효과 확인 중', resolved: '해결 · 사용자 확인', deferred: '보류', cancelled: '취소' };
const TRANSITIONS = { proposed: ['accepted', 'applied', 'deferred', 'cancelled'], accepted: ['applied', 'deferred', 'cancelled'], applied: ['resolved', 'deferred', 'cancelled'], resolved: ['applied'], deferred: ['accepted', 'applied', 'cancelled'], cancelled: ['proposed'] };

function text(value, max = 2000) {
  if (typeof value !== 'string' || value.length > max) throw new Error('텍스트 길이나 형식을 확인해주세요.');
  return value.trim();
}
function number(value, label, allowZero = false) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new Error(`${label}을 입력해주세요.`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Error(`${label}은 ${allowZero ? '0 이상' : '0보다 큰'}의 숫자여야 해요.`);
  return n;
}
function calculateFleet(input) {
  const demand = number(input.demand, '홉 소비량', true);
  const cycle = number(input.cycle, '왕복 시간');
  const slots = number(input.slots, '홉 화물칸 수');
  const perSlot = number(input.perSlot, '한 칸의 적재량');
  if (!Number.isInteger(slots) || slots > 100) throw new Error('화물칸 수는 1~100 사이의 정수여야 해요.');
  const capacity = slots * perSlot;
  const required = demand * cycle;
  const ratio = required / capacity;
  if (![capacity, required, ratio].every(Number.isFinite)) throw new Error('입력한 수치가 계산 범위를 넘었어요.');
  const ships = demand === 0 ? 0 : Math.max(1, Math.ceil(ratio - Number.EPSILON * Math.max(1, ratio) * 4));
  const production = input.production === '' || input.production == null ? null : number(input.production, '홉 생산량', true);
  return { ships, capacity, required, demand, cycle, production, productionShortfall: production !== null && production < demand, buffer: required };
}
function transitionPlan(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) throw new Error('현재 계획에서 선택할 수 없는 상태예요.');
  return to;
}
function frameDifference(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  return a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0) / (a.length * 255);
}
function validateAnswer(answer, evidence) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('AI 답변 형식이 올바르지 않아요.');
  const byId = new Map(evidence.map(f => [f.id, f]));
  const strings = key => {
    if (!Array.isArray(answer[key]) || answer[key].length > 12) throw new Error('AI 답변 목록이 올바르지 않아요.');
    return answer[key].map(v => text(v, 1000));
  };
  if (!Array.isArray(answer.facts) || answer.facts.length > 12) throw new Error('AI 근거 목록이 올바르지 않아요.');
  const facts = answer.facts.map(f => {
    if (!byId.has(f.evidence_id)) throw new Error('AI 답변에 확인할 수 없는 화면 근거가 있어요.');
    return { text: text(f.text, 1000), evidence_id: f.evidence_id };
  });
  if (!Array.isArray(answer.annotations) || answer.annotations.length > 3) throw new Error('화면 표시는 최대 3개까지 가능해요.');
  const annotations = answer.annotations.map(a => {
    if (!byId.has(a.evidence_id)) throw new Error('화면 표시의 원본을 확인할 수 없어요.');
    if (![a.x, a.y, a.width, a.height].every(n => typeof n === 'number' && Number.isFinite(n)) || a.x < 0 || a.y < 0 || a.width <= 0 || a.height <= 0 || a.x + a.width > 1 || a.y + a.height > 1) throw new Error('화면 표시가 이미지 범위를 벗어났어요.');
    return { evidence_id: a.evidence_id, x: a.x, y: a.y, width: a.width, height: a.height, label: text(a.label, 150) };
  });
  if (typeof answer.should_speak !== 'boolean' || !['quiet', 'reaction', 'help', 'follow_up'].includes(answer.event_type) || typeof answer.focus_busy !== 'boolean' || typeof answer.goal_related !== 'boolean') throw new Error('동료의 반응 판단 형식이 올바르지 않아요.');
  const summary = text(answer.summary), eventKey = text(answer.event_key, 150);
  if (answer.should_speak && !summary) throw new Error('동료의 답변이 비어 있어요.');
  const learning_proposals = require('./learning.cjs').validateProposals(answer.learning_proposals, evidence);
  return { summary, should_speak: answer.should_speak, event_type: answer.event_type, event_key: eventKey, focus_busy: answer.focus_busy, goal_related: answer.goal_related, facts, hypotheses: strings('hypotheses'), missing_information: strings('missing_information'), suggestions: strings('suggestions'), memory_proposals: strings('memory_proposals'), next_action: text(answer.next_action, 1000), annotations, learning_proposals };
}
function gameLabel(game) { return game === 'anno1800' ? 'Anno 1800' : game === 'factorio' ? 'Factorio' : game; }
function companionProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['calm', 'playful', 'thoughtful'].includes(input.style) || !['casual', 'polite'].includes(input.tone)) throw new Error('동료의 말투를 확인해주세요.');
  const name = text(input.name, 30), preferences = text(input.preferences ?? '', 500);
  if (!name) throw new Error('동료 이름을 입력해주세요.');
  return { name, style: input.style, tone: input.tone, preferences };
}
function conversation(records) {
  return records.filter(r => r.kind === 'answer' && r.payload.summary && (!r.payload.automatic || r.payload.delivered === true)).slice(0, 12).reverse().map(r => ({ id: r.id, question: r.payload.automatic ? null : r.payload.question, reply: r.payload.summary, source: r.source, time: r.created_at }));
}
function proactiveDecision(answer, { mode, goal, status, sampleStable = true, evidence, records, now = Date.now() }) {
  if (mode === 'quiet') return 'quiet-mode';
  if (!answer.should_speak || answer.event_type === 'quiet') return 'nothing-new';
  if (answer.focus_busy) return 'focused-play';
  if (!sampleStable) return 'scene-changed';
  if (!answer.event_key) return 'missing-event';
  const current = new Set(evidence.filter(f => f.source === 'window' && now - Date.parse(f.payload.capturedAt) >= 0 && now - Date.parse(f.payload.capturedAt) < 15000).map(f => f.id));
  if (!answer.facts.some(f => current.has(f.evidence_id))) return 'no-current-evidence';
  if (answer.goal_related && ['cancelled', 'deferred'].includes(status)) return 'inactive-plan';
  if (mode === 'watch' && (!goal || !answer.goal_related || !['help', 'follow_up'].includes(answer.event_type))) return 'outside-watch';
  const turns = records.filter(r => r.kind === 'answer' && (!r.payload.automatic || r.payload.delivered));
  if (turns.some(r => now - Date.parse(r.created_at) < 60000)) return 'cooldown';
  const auto = turns.filter(r => r.payload.automatic);
  if (auto.filter(r => now - Date.parse(r.created_at) < 600000).length >= 3) return 'frequency-limit';
  // ponytail: canonical event keys + matching text suppress repeats; semantic paraphrases need real-play calibration.
  if (auto.some(r => now - Date.parse(r.created_at) < 300000 && (r.payload.event_key === answer.event_key || r.payload.summary === answer.summary))) return 'duplicate';
  return null;
}
function localAnswer(intent, world) {
  const base = { facts: [], hypotheses: [], missing_information: [], suggestions: [], memory_proposals: [], annotations: [], next_action: ROUTE_STEPS[world.state.step || 0].next, local: true };
  if (world.game !== 'anno1800') return { ...base, summary: '이 게임에서는 현재 목표와 기록을 바탕으로 함께 조사할 수 있어요. 화면을 관찰하고 AI를 연결해주세요.', next_action: '게임 화면과 현재 목표를 확인해주세요.' };
  if (intent === 'cargo') return { ...base, summary: '홉 섬 → 메인섬에는 홉을, 반대 방향에는 홉 섬 주민에게 부족한 생활물품을 보내면 좋아요.', suggestions: ROUTE_STEPS[4].items, next_action: ROUTE_STEPS[4].next };
  if (intent === 'fleet') return { ...base, summary: '지금 자료로는 필요한 배 수를 확정할 수 없어요. 가까운 두 섬의 소규모 운송은 한 척부터 시험하고 재고 흐름을 확인할 수 있어요.', missing_information: ['메인섬의 홉 소비량, 실제 왕복 시간, 홉에 배정할 화물칸의 적재량이 필요해요.'], suggestions: ['아래 선박 계산기에 관찰한 수치를 입력하면 단순 수송량 기준의 최소 척수 후보를 계산해요.', '홉 생산량이 부족하거나 하역이 막히면 배를 늘리는 것만으로 해결되지 않아요.'], next_action: '우선 생산·소비 통계에서 홉 소비량을 확인해주세요.' };
  if (intent === 'verify') return { ...base, summary: '무역로를 적용했다는 기록과 공급이 안정됐다는 확인은 따로 남겨요.', suggestions: ROUTE_STEPS[5].items, next_action: '다음 왕복에서 홉의 적재·하역과 메인섬 재고를 확인해주세요.' };
  return { ...base, summary: '먼저 홉 섬을 준비하고, 홉을 메인섬으로 옮기는 일반 무역로부터 만들어요. 자금은 공유되며 건설 재료는 배로 옮겨요.', suggestions: ['새 일반 무역로 → 두 섬 추가 → 선박 배정 → 홉 적재·하역 → 실제 운송 확인 순서예요.', '아래 안내에서 한 단계씩 진행할 수 있어요. 무역로 화면을 확보하면 실제 UI에 표시하며 설명할 수 있어요.'] };
}
module.exports = { ROUTE_STEPS, PLAN_STATES, TRANSITIONS, text, number, calculateFleet, transitionPlan, frameDifference, validateAnswer, localAnswer, gameLabel, companionProfile, conversation, proactiveDecision };
