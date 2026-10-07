const $ = selector => document.querySelector(selector);
let state, view = 'play', selectedWindow, pinnedFrame, marksVisible = true, timer, stream, captureRun = 0, captureBusy = false, pauseGap = false, asking = false, settingsInitialized = false, toastTimer;
let editingRecord;
let pinnedAnswer, focusedEvidenceId, correctionFrame, correctionLabel;
let messageSignature = '', activePing = 0;
let editingExperience = null, experienceMode = 'new';
const video = $('#game-video');
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { alpha: false });
const labels = { user: '사용자 진술', video: '첨부 영상', window: '창 캡처', model: 'AI 해석 · 확인 필요', guide: '로컬 가이드', provider: 'API 요청', app: '앱 상태' };
const time = value => value ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '시각 미확인';
const videoTime = value => `${String(Math.floor((value || 0) / 60)).padStart(2, '0')}:${String(Math.floor((value || 0) % 60)).padStart(2, '0')}`;
function node(tag, className, content) { const element = document.createElement(tag); if (className) element.className = className; if (content != null) element.textContent = content; return element; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
async function call(name, input) { const result = await window.companion.call(name, input); if (!result.ok) throw new Error(result.error); return result.value; }
function safe(action) { return async event => { try { await action(event); } catch (error) { toast(error.message); } }; }
function world() { return state.worlds.find(w => w.id === state.activeWorld); }
function setView(next) {
  view = next;
  for (const name of ['play', 'memory', 'settings']) $(`#${name}-view`).hidden = name !== next;
  document.querySelectorAll('.nav-button').forEach(b => b.classList.toggle('active', b.dataset.view === next));
  if (next === 'memory') renderMemory();
}
function gameLabel(game) { return game === 'anno1800' ? 'Anno 1800' : game === 'factorio' ? 'Factorio' : game; }
const shortcutLabel = accelerator => accelerator?.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ') || '단축키 사용 불가';
function render(next) {
  const previousWorld = state?.activeWorld;
  const previousAnswer = state?.records.find(r=>r.kind==='answer' && !r.payload.automatic)?.id;
  state = next;
  const w = world();
  if (pinnedFrame) pinnedFrame = state.records.find(r => r.id === pinnedFrame.id && r.payload.available) || null;
  if (pinnedAnswer) pinnedAnswer = state.records.find(r => r.id === pinnedAnswer.id) || null;
  if (previousWorld !== state.activeWorld) { editingExperience = null; $('#experience-dialog').close(); }
  if (previousWorld !== state.activeWorld) { pinnedFrame = null; pinnedAnswer = null; focusedEvidenceId = null; correctionFrame = null; $('#question-reference').hidden = true; $('#evidence-dialog').close(); $('#evidence-crop-view').replaceChildren(); $('#evidence-original').removeAttribute('src'); selectedWindow = null; messageSignature = ''; $('#source-kind').value = 'window'; $('#question').value = ''; $('#case-tools').open = false; $('#fleet-form').reset(); $('#fleet-result').replaceChildren(); $('#memory-search').value = ''; }
  document.body.classList.toggle('compact', state.compact);
  document.body.classList.toggle('overlay-input', state.compact && state.overlay.interactive);
  if (state.compact) setView('play');
  if (state.compact && !state.overlay.interactive) { $('#question').blur(); document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }
  $('#compact-toggle').textContent = state.compact ? '큰 창으로 ↗' : '게임 위 오버레이 ↗';
  $('#window-title').textContent = state.compact ? `${state.settings.profile.name} · 게임 오버레이` : '동료 · AI Game Companion';
  $('#window-maximize').hidden = state.compact;
  $('#overlay-home').hidden = $('#overlay-return').hidden = $('#overlay-hint').hidden = !state.compact;
  $('#overlay-return').disabled = !state.overlay.shortcuts.chat;
  $('#overlay-hint').textContent = !state.overlay.shortcuts.chat ? '단축키 충돌 · 마우스로 입력할 수 있어요. 큰 창에서 다시 실행해주세요.' : state.overlay.interactive ? 'Enter 보내기 · Esc 게임 복귀 · 위쪽을 끌어 위치 이동' : `${shortcutLabel(state.overlay.shortcuts.chat)} 질문${state.overlay.shortcuts.visibility ? ` · ${shortcutLabel(state.overlay.shortcuts.visibility)} 숨기기` : ''} · 클릭은 게임으로`;
  $('#overlay-settings-hint').textContent = `현재 질문 키: ${shortcutLabel(state.overlay.shortcuts.chat)} · 숨기기 키: ${shortcutLabel(state.overlay.shortcuts.visibility)}. 평소에는 클릭이 게임으로 통과해요. Esc로 질문을 보존하고 게임으로 돌아가요.`;
  $('#compact-stop').hidden = !state.compact || !state.observation.observing;
  $('#companion-name').textContent = $('#chat-name').textContent = state.settings.profile.name;
  $('#companion-mode').value = state.settings.mode;
  $('#mode-description').textContent = { quiet: '부르면 대답할게.', watch: '정한 목표의 변화를 지켜볼게.', together: '새로운 순간에 짧게 반응할게.' }[state.settings.mode];
  $('#world-select').replaceChildren(...state.worlds.map(w => { const option = node('option', '', w.name); option.value = w.id; return option; }));
  $('#world-select').value = w.id;
  $('#game-name').textContent = gameLabel(w.game);
  if (document.activeElement !== $('#goal')) $('#goal').value = w.goal;
  $('#topic-title').textContent = w.name;
  $('#topic-subtitle').textContent = `${gameLabel(w.game)} · 화면을 공유하면 지금 장면도 함께 이야기해요.`;
  const example = w.state.scenario === 'anno-hops';
  for (const id of ['case-tools', 'route-diagram', 'guide-card', 'fleet-card']) $(`#${id}`).hidden = !example;
  document.querySelectorAll('[data-intent]').forEach(button => { button.hidden = !example; });
  $('#recap-title').textContent = w.goal || '아직 정한 목표가 없어도 괜찮아.';
  const note = state.records.find(r => r.kind === 'note' && r.source === 'user');
  $('#recap-note').textContent = note?.payload.text || '나눈 이야기와 직접 남긴 기억을 이 플레이에서 이어가요.';
  $('#plan-badge').textContent = w.state.status === 'proposed' ? '제안 · 미적용' : state.planStates[w.state.status];
  $('.supply-card .subtle-badge').textContent = ['applied', 'resolved'].includes(w.state.status) ? '개념도 · 제안 구성' : '개념도 · 미적용';
  renderGuide(); renderPlan(); renderMessages(); renderExperiences(); renderSettings();
  if (state.compact && !state.overlay.interactive) $('#messages').scrollTop = 0;
  for (const [key, value] of Object.entries(w.state.inputs)) { const field = $(`[name="${key}"]`); if (field && document.activeElement !== field) field.value = value; }
  const observing = state.observation.observing;
  const mode = $('#source-kind').value;
  $('#toggle-capture').textContent = observing ? '관찰 중지' : mode === 'video' ? '리플레이 시작' : '관찰 시작';
  $('#choose-source').textContent = mode === 'video' ? '영상 선택' : '창 선택';
  $('#source-kind').disabled = observing;
  $('#choose-source').disabled = observing;
  $('#source-name').textContent = observing ? state.observation.source : mode === 'video' ? (state.reference?.name || '영상 미선택') : (selectedWindow?.name || '게임 창 미선택');
  $('#observation-label').replaceChildren(node('span', 'dot'), document.createTextNode(observing ? (mode === 'video' ? '영상 리플레이 중' : '선택한 창 관찰 중') : '관찰 대기'));
  $('#observation-label').classList.toggle('running', observing);
  $('#last-observation').textContent = state.observation.lastFrame ? `마지막 캡처 ${time(state.observation.lastFrame)}` : '화면 공유 없이도 대화할 수 있어요';
  $('#capture-now').disabled = !observing;
  const connected = state.settings.hasKey && state.settings.analysisConsent;
  $('#chat-mode').textContent = connected ? (observing ? '함께 보는 중' : '대화 가능') : '연결 대기';
  $('#send-question').textContent = connected ? '보내기 ↑' : 'AI 연결 ↗';
  $('#chat-footer').textContent = connected ? (state.compact ? (observing ? `${state.observation.source} · 화면 공유 중` : '화면 공유 없이 대화 중 · 큰 창에서 게임 창을 선택해요') : (observing && state.settings.mode !== 'quiet' && !state.settings.autoAnalyze ? '먼저 반응하려면 설정에서 자동 화면 확인도 켜주세요.' : `${shortcutLabel(state.overlay.shortcuts.chat)}로 게임 위에서 바로 질문해요.`)) : '연결과 설정에서 AI를 연결하면 대화를 시작할 수 있어요.';
  if (!observing) {
    const answer=state.records.find(r=>r.kind==='answer' && !r.payload.automatic);
    if(answer && (previousWorld!==w.id || answer.id!==previousAnswer)){
      const refs=[...(answer.payload.facts||[]).map(f=>f.evidence_id),...(answer.payload.annotations||[]).map(m=>m.evidence_id)];
      const frame=state.records.find(r=>r.kind==='frame' && r.payload.available && refs.includes(r.id));
      if(frame){pinnedFrame=frame;pinnedAnswer=answer;}
    }
    const frame = pinnedFrame?.world_id === w.id ? pinnedFrame : state.records.find(r => r.kind === 'frame' && r.payload.available);
    if (frame) showEvidence(frame, state.records.find(r=>r.id===pinnedAnswer?.id));
    else { pinnedFrame = null; $('#open-evidence').disabled = true; $('#evidence-image').hidden = true; $('#evidence-image').removeAttribute('src'); video.hidden = true; $('#annotations').replaceChildren(); $('#screen-empty').hidden = false; $('#frame-label').textContent = '아직 공유한 화면이 없어요'; $('#frame-time').textContent = ''; $('#screen-note').textContent = '게임 창이나 영상을 선택하면 화면을 확인할 수 있어요.'; }
  }
  if (view === 'memory') renderMemory();
}
function renderGuide() {
  const step = world().state.step || 0;
  const shortNames = ['섬 준비', '항로', '선박', '홉 운송', '복귀 물품', '동작 확인'];
  $('#steps').replaceChildren(...state.steps.map((s, i) => {
    const button = node('button', `step-button${step === i ? ' active' : ''}`);
    button.append(node('span', '', String(i + 1)), document.createTextNode(shortNames[i]));
    button.setAttribute('aria-label', `${i + 1}단계: ${s.title}`);
    if (step === i) button.setAttribute('aria-current', 'step');
    button.onclick = safe(async () => render(await call('world:update', { step: i })));
    return button;
  }));
  const current = state.steps[step];
  $('#cargo-example').hidden = step < 3 || step > 4;
  $('#step-counter').textContent = `${String(step + 1).padStart(2, '0')} / 06`;
  $('#guide-title').textContent = current.title; $('#guide-lead').textContent = current.lead;
  $('#guide-items').replaceChildren(...current.items.map(item => node('li', '', item)));
  $('#guide-next').textContent = `↗ ${current.next}`;
  $('#previous-step').disabled = step === 0;
  $('#next-step').textContent = step === 5 ? '설정 후 확인 안내 ↗' : '다음 안내 →';
}
function renderPlan() {
  const status = world().state.status;
  $('#plan-status').textContent = state.planStates[status];
  $('#plan-explanation').textContent = { proposed: '계획을 수락해도 게임에 적용한 것으로 기록하지 않아요.', accepted: '수락한 계획이에요. 실제 설정은 내가 게임에서 진행해요.', applied: '사용자가 적용했다고 기록했어요. 운송과 재고 흐름의 효과를 확인해요.', resolved: '사용자가 해결됐다고 확인한 기록이에요. 새로운 문제가 생기면 재조사할 수 있어요.', deferred: '보류한 계획이에요. 다시 시작할 때 이어갈 수 있어요.', cancelled: '취소한 계획은 자동으로 권하지 않아요.' }[status];
  const names = { accepted: '계획에 추가', applied: status === 'resolved' ? '문제 다시 조사' : '적용했어요', resolved: '해결됐어요', deferred: '보류', cancelled: '취소', proposed: '새로 제안 받기' };
  $('#plan-actions').replaceChildren(...(state.transitions[status] || []).map(to => {
    const button = node('button', to === 'applied' || to === 'accepted' ? 'primary small' : 'secondary small', names[to]);
    button.onclick = safe(async () => {
      render(await call('world:update', { status: to }));
      if (to === 'applied') { const result = await call('chat:local', 'verify'); render(result.snapshot); }
      toast(`계획 상태를 “${state.planStates[to]}”로 기록했어요.`);
    }); return button;
  }));
}
function drawMarks(frame, answer = pinnedAnswer) {
  const svg = $('#annotations'); svg.replaceChildren();
  svg.hidden = !marksVisible;
  if (!marksVisible) return;
  const width = frame.payload.width, height = frame.payload.height;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const marks = answer ? (answer.payload.annotations || []).filter(a => a.evidence_id === frame.id) : (frame.payload.annotations || []);
  marks.slice(0, 3).forEach((mark, index) => {
    const make = (tag, attributes) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attributes)) e.setAttribute(key, value); return e; };
    const x = mark.x * width, y = mark.y * height, boxWidth = mark.width * width, boxHeight = mark.height * height;
    const color = index === 0 ? '#f0d694' : '#b5db94';
    const scale = width / (svg.getBoundingClientRect().width || width), radius = 13 * scale;
    const button = make('g', { role: 'button', tabindex: 0, 'aria-label': `${mark.label} 확대`, class: 'annotation-button' });
    button.append(make('rect', { x, y, width: boxWidth, height: boxHeight, rx: 6, fill: 'transparent', stroke: color, 'stroke-width': 2 * scale }));
    const labelX = Math.min(width-radius, x+radius), labelY = Math.max(radius, y-radius);
    button.append(make('circle', { cx:labelX, cy:labelY, r:radius, fill:'#244b3a', stroke:color, 'stroke-width':scale }));
    const label = make('text', { x:labelX, y:labelY+5*scale, 'text-anchor':'middle', fill:color, 'font-size':14*scale, 'font-family':'Malgun Gothic, sans-serif' });
    label.textContent = String(index+1); button.append(label);
    button.onclick = () => openEvidence(frame, mark, answer);
    button.onkeydown = event => { if(['Enter',' '].includes(event.key)){ event.preventDefault(); openEvidence(frame,mark,answer); } };
    svg.append(button);
  });
}
function showEvidence(frame, answer = null) {
  if (!frame.payload.available) return;
  if (state.observation.observing) { openEvidence(frame, null, answer); return; }
  pinnedFrame = frame;
  pinnedAnswer = answer;
  $('#open-evidence').disabled = false;
  $('#screen-empty').hidden = true; video.hidden = true; $('#evidence-image').hidden = false;
  $('#evidence-image').src = frame.payload.url;
  const isVideo = frame.source === 'video';
  $('#frame-label').textContent = isVideo ? '기록 화면 · 첨부 영상' : '기록 화면 · 창 캡처';
  $('#frame-time').textContent = isVideo ? `영상 ${videoTime(frame.payload.videoTime)} · 현재 상태 아님` : time(frame.payload.capturedAt || frame.created_at);
  $('#screen-note').textContent = frame.payload.text || '이 시점에서 보이는 화면만 근거로 사용해요. 화면 밖 상태는 미확인이에요.';
  drawMarks(frame);
}
function evidenceCaption(frame) { return frame.source === 'video' ? `기록 화면 · 영상 ${videoTime(frame.payload.videoTime)} · 현재 상태 아님` : `기록 화면 · ${time(frame.payload.capturedAt || frame.created_at)}`; }
function evidenceCrop(frame, mark) {
  const crop = node('div','evidence-crop'), image = node('img'); image.src = frame.payload.url; image.alt = mark?.label || '선택한 기록의 원본 화면';
  let ratio=frame.payload.width/frame.payload.height;
  if(mark){
    const x=Math.max(0,mark.x-.02), y=Math.max(0,mark.y-.02), width=Math.min(1,mark.x+mark.width+.02)-x, height=Math.min(1,mark.y+mark.height+.02)-y;
    crop.style.aspectRatio=`${frame.payload.width*width} / ${frame.payload.height*height}`;
    ratio=frame.payload.width*width/(frame.payload.height*height);
    Object.assign(image.style,{position:'absolute',width:`${100/width}%`,height:`${100/height}%`,maxWidth:'none',left:`${-100*x/width}%`,top:`${-100*y/height}%`});
  }
  crop.style.setProperty('--thumb-width',`${160*ratio}px`);
  image.onerror=()=>{crop.replaceChildren(node('p','help-text','원본을 읽을 수 없어요. 기록 화면을 다시 확인해주세요.'));};
  crop.append(image); return crop;
}
function openEvidence(frame, mark = null, answer = null) {
  if (!frame.payload.available) { toast('원본 이미지가 없어요.'); return; }
  correctionFrame=frame; correctionLabel=mark?.label || '화면'; focusedEvidenceId=frame.id;
  $('#question-reference').textContent=`이 이미지 기준으로 질문 · ${frame.source==='video'?`영상 ${videoTime(frame.payload.videoTime)}`:time(frame.payload.capturedAt)} ×`; $('#question-reference').hidden=false;
  $('#evidence-title').textContent=correctionLabel; $('#evidence-caption').textContent=evidenceCaption(frame);
  const modelMark=mark && answer?.source==='model' && mark.evidence_id===frame.id;
  $('#evidence-trust').textContent=modelMark?'AI가 짚은 위치예요. 원본과 비교하고 잘못 짚었다면 바로 알려주세요.':mark?'기록 화면에서 선택한 영역이에요. 이후의 변경과 결과는 별도로 확인해요.':'이 답변에서 참고한 원본 기록이에요. 화면에 없는 최신 상황은 별도로 확인해요.';
  $('#evidence-crop-view').replaceChildren(evidenceCrop(frame,mark));
  $('#evidence-original').src=frame.payload.url; $('#evidence-original').alt='표시와 비교할 기록 원본'; $('#evidence-original-details').hidden=!mark; $('#evidence-original-details').open=false;
  $('#evidence-dialog').showModal();
}
function evidenceVisual(frame, mark, answer) {
  const figure=node('figure','evidence-visual'), button=node('button','evidence-thumbnail'); button.type='button'; button.setAttribute('aria-label',`${mark?.label || '근거 화면'} 확대`);
  button.append(evidenceCrop(frame,mark),node('span','evidence-title',mark?.label || '이 답변의 근거 화면'));
  button.onclick=()=>openEvidence(frame,mark,answer);
  figure.append(button,node('figcaption','',`${evidenceCaption(frame)} · ${mark && answer.source==='model'?'AI 표시 · 확인 필요':'답변의 원본 근거'}`)); return figure;
}
function renderMessages() {
  const answers = state.records.filter(r => r.kind === 'answer' && (!r.payload.automatic || r.payload.delivered === true)).slice(0, 20).reverse();
  const signature = JSON.stringify([state.activeWorld, answers.map(r => [r.id, r.payload]), state.records.filter(r => r.kind === 'frame').map(r => [r.id, r.payload.available, r.payload.expired]), state.records.filter(r => r.kind === 'experience').map(r => [r.id, r.payload.revision])]);
  if (signature === messageSignature) return;
  messageSignature = signature;
  const wasNearBottom = $('#messages').scrollHeight - $('#messages').scrollTop - $('#messages').clientHeight < 100;
  $('.chat-intro').hidden = answers.length > 0;
  const fragments = answers.flatMap(record => {
    const answer = record.payload;
    const user = node('div', 'user-bubble', answer.question);
    const bubble = node('div', 'answer-bubble');
    bubble.append(node('span', 'answer-source', `${record.source === 'model' ? (answer.automatic ? '먼저 건넨 말' : '대화') : 'Anno 예제 · 로컬 안내'} · ${time(record.created_at)}`), node('div', 'answer-summary', answer.summary));
    const marks=answer.annotations || [], references=[...new Set([...(answer.facts||[]).map(f=>f.evidence_id),...marks.map(m=>m.evidence_id)])];
    const visuals=node('div','answer-visuals');
    for(const id of references.slice(0,2)){
      const frame=state.records.find(r=>r.id===id && r.kind==='frame'); if(!frame?.payload.available) continue;
      const targets=marks.filter(m=>m.evidence_id===id);
      for(const mark of targets.length?targets:[null]) visuals.append(evidenceVisual(frame,mark,record));
    }
    if(visuals.childElementCount) bubble.append(visuals);
    if(answer.next_action && (record.source==='guide' || ['help','follow_up'].includes(answer.event_type))) bubble.append(node('div','answer-next',`지금 한 가지 · ${answer.next_action}`));
    const detail = node('details'); detail.append(node('summary', '', '근거와 자세한 생각 보기'));
    if ((answer.facts || []).length) {
      detail.append(node('h4', '', '화면에서 읽은 내용'));
      const list = node('ul');
      answer.facts.forEach(fact => {
        const item = node('li', '', fact.text + ' ');
        const frame = state.records.find(r => r.id === fact.evidence_id && r.kind === 'frame');
        if (frame?.payload.available) { const button = node('button', 'evidence-link', '근거 화면 ↗'); button.onclick = () => openEvidence(frame, null, record); item.append(button); }
        else item.append(node('span', 'muted', frame?.payload.expired ? '(원본 이미지 보관 기간이 지났어요)' : '(원본 근거가 없어요)'));
        list.append(item);
      }); detail.append(list);
    }
    if (answer.missing_information?.length) detail.append(node('p', 'answer-next', `더 확인할 것 · ${answer.missing_information[0]}`));
    for (const [key, title] of [['hypotheses', '가능한 원인 · 추정'], ['suggestions', '제안과 조건'], ['memory_proposals', '기억 후보 · 아직 저장되지 않음']]) {
      if (!answer[key]?.length) continue;
      detail.append(node('h4', '', title), (() => { const list = node('ul'); list.append(...answer[key].map(v => node('li', '', v))); return list; })());
    }
    if (record.source === 'guide') detail.append(node('p', 'help-text', '일반 가이드는 저장소 사례와 개발사 설명을, 기본 단축키와 진입 아이콘은 Anno 커뮤니티 위키를 참고해요. 키 변경·버전·모드와 실제 항로 설정은 추가 확인이 필요해요.'));
    if (detail.childElementCount > 1) bubble.append(detail);
    if (answer.automatic) { const dismiss = node('button', 'text-button', '이 반응은 그만'); dismiss.onclick = safe(async () => render(await call('chat:dismiss', record.id))); bubble.append(dismiss); }
    if (answer.experience_ids?.length) {
      const learning = node('div', 'answer-learning');
      for (const id of answer.experience_ids) {
        const experience = state.records.find(r => r.id === id && r.kind === 'experience');
        if (experience) learning.append(experienceCard(experience));
      }
      if (learning.childElementCount) bubble.append(learning);
    }
    return answer.automatic ? [bubble] : [user, bubble];
  });
  $('#messages').replaceChildren(...fragments);
  if (!answers.length) $('#messages').append(node('p', 'help-text', '“아까 하던 거 이어가자”처럼 편하게 말해요. 현재 장면이 궁금하면 게임 창도 공유해주세요.'));
  if (wasNearBottom || !answers.at(-1)?.payload.automatic) $('#messages').scrollTop = $('#messages').scrollHeight;
}
function renderSettings(force = false) {
  $('#connection-status').textContent = state.settings.hasKey ? '키 연결됨' : '미연결';
  const usage = state.settings.usage;
  $('#usage-label').textContent = `오늘 앱 요청 ${usage.requests}회 / ${state.settings.maxRequests}회 · ${usage.reportedCost === null ? '비용 미확인' : `확인된 비용 $${usage.reportedCost.toFixed(5)}`} · 비용 미확인 ${usage.unknown}건`;
  if (!settingsInitialized || force) {
    $('#analysis-consent').checked = state.settings.analysisConsent;
    $('#auto-analyze').checked = state.settings.autoAnalyze;
    $('#request-limit').value = state.settings.maxRequests;
    $('#analysis-interval').value = String(state.settings.analysisInterval);
    const select = $('#model-select');
    if (state.settings.model && ![...select.options].some(o => o.value === state.settings.model)) { const option = node('option', '', state.settings.model); option.value = state.settings.model; select.append(option); }
    select.value = state.settings.model; settingsInitialized = true;
  }
  $('#api-key').placeholder = state.settings.hasKey ? '연결된 키는 표시하지 않아요. 변경하려면 새 키를 입력하세요.' : 'sk-or-…';
}
function openExperience(record = null, mode = 'new') {
  editingExperience = record; experienceMode = mode;
  const form = $('#experience-form'); form.reset();
  for (const key of ['title', 'hypothesis', 'action', 'check', 'conditions', 'result']) form.elements[key].value = record?.payload[key] || '';
  form.elements.outcome.replaceChildren(...Object.entries(state.outcomes).map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
  form.elements.outcome.value = record?.payload.outcome || 'inconclusive';
  $('#experience-dialog-title').textContent = mode === 'result' ? '적용 뒤에 어떻게 달라졌어?' : record ? '경험 내용 바로잡기' : '같이 해볼 작은 시도';
  $('#experience-details').hidden = mode === 'result';
  const resultVisible = mode === 'result' || record?.payload.status === 'completed';
  $('#experience-result-fields').hidden = !resultVisible;
  form.elements.result.required = resultVisible; form.elements.result.disabled = !resultVisible;
  form.elements.outcome.disabled = !resultVisible;
  $('#experience-dialog').showModal();
}
function experienceCard(record) {
  const p = record.payload, card = node('article', 'experience-card'); card.dataset.experience = record.id;
  card.append(node('span', 'experience-status', state.experienceStates[p.status]), node('h4', '', p.title), node('p', '', `시도 · ${p.action}`), node('p', 'help-text', `확인 · ${p.check}`));
  if (p.hypothesis) card.append(node('p', 'help-text', `가설 · ${p.hypothesis}`));
  if (p.conditions) card.append(node('p', 'help-text', `조건 · ${p.conditions}`));
  if (p.result) card.append(node('p', '', `${state.outcomes[p.outcome]} · 사용자 보고: ${p.result}`));
  if (p.needs_review) card.append(node('p', 'help-text', '근거 만료·내용 변경으로 다시 확인할 경험이에요.'));
  const pictures = node('div', 'experience-evidence');
  for (const [key, label] of [['before_evidence', '시도 전 근거'], ['after_evidence', '결과 기록 때의 화면']]) for (const id of p[key] || []) {
    const frame = state.records.find(r => r.id === id && r.kind === 'frame');
    if (frame?.payload.available) { const link = node('button', 'text-button', `${label} ↗`); link.onclick = () => openEvidence(frame); pictures.append(link); }
    else if (frame) pictures.append(node('span', 'help-text', `${label} · 원본 없음${frame.payload.expired ? ' (보관 만료)' : ''}`));
    else {
      const link = node('button', 'text-button', `${label} 보기 ↗`);
      link.onclick = safe(async () => {
        const frame = await call('record:get', id);
        if (frame.world_id !== state.activeWorld) return;
        if (!frame.payload.available) { toast(frame.payload.expired ? '원본 이미지 보관 기간이 지났어요.' : '원본 이미지를 찾을 수 없어요.'); return; }
        openEvidence(frame);
      });
      pictures.append(link);
    }
  }
  if (pictures.childElementCount) card.append(pictures);
  const actions = node('div', 'experience-actions');
  const titles = { accepted: '해보기', applied: '적용했어', completed: '결과 남기기', deferred: '나중에', rejected: '이번엔 안 할래' };
  for (const status of state.experienceTransitions[p.status] || []) {
    const button = node('button', 'secondary small', titles[status]);
    button.onclick = status === 'completed' ? () => openExperience(record, 'result') : safe(async () => render(await call('experience:update', { id: record.id, expected_revision: p.revision, status })));
    actions.append(button);
  }
  const edit = node('button', 'text-button', '내용 수정'); edit.onclick = () => openExperience(record, 'edit'); actions.append(edit); card.append(actions);
  return card;
}
function renderExperiences() {
  const records = state.records.filter(r => r.kind === 'experience');
  const active = records.filter(r => ['proposed', 'accepted', 'applied'].includes(r.payload.status));
  const recent = records.filter(r => r.payload.status === 'completed').slice(0, 2);
  $('#experience-list').replaceChildren(...[...active.slice(0, 4), ...recent].map(experienceCard));
  if (!active.length && !recent.length) $('#experience-list').append(node('p', 'help-text', '함께 고른 작은 시도와 결과를 여기에서 이어가요.'));
  $('#experience-count').textContent = active.length ? `진행 중 ${active.length}개 · 전체는 월드 기억에서` : '제안 수락 · 적용 · 결과를 따로 기억해요';
}
function renderMemory(records = state.records) {
  const visible = records.filter(r => r.kind !== 'usage');
  $('#record-list').replaceChildren(...visible.map(record => {
    const card = node('article', 'record-card'), meta = node('div', 'record-meta');
    const remove = node('button', 'text-button danger', '삭제');
    remove.onclick = safe(async () => { if (window.confirm('이 기록과 연결된 답변을 삭제할까요?')) { render(await call('record:delete', record.id)); } });
    const controls = node('div');
    if (record.kind === 'note' && record.source === 'user') {
      const edit = node('button', 'text-button', '수정');
      edit.onclick = () => { editingRecord = record.id; $('#edit-note').value = record.payload.text; $('#record-dialog').showModal(); };
      controls.append(edit, document.createTextNode(' · '));
    }
    controls.append(remove); meta.append(node('span', '', `${labels[record.source] || record.source} · ${time(record.created_at)}`), controls); card.append(meta);
    if (record.kind === 'experience') { card.append(experienceCard(record)); return card; }
    card.append(node('p', '', record.payload.text || record.payload.summary || record.payload.question || (record.kind === 'answer' ? '새로 말할 일이 없어 조용히 지켜봤어요.' : { frame: '기록한 화면', goal: '목표를 비웠어요.', plan: '계획 기록' }[record.kind] || '플레이 기록')));
    if (record.kind === 'frame' && record.payload.available) {
      const image = node('img'); image.src = record.payload.url; image.alt = `${labels[record.source]} 근거 화면`; image.loading = 'lazy'; card.append(image);
      const show = node('button', 'text-button', '원본 확대해서 보기 ↗'); show.onclick = () => { setView('play'); openEvidence(record); }; card.append(show);
    }
    if (record.kind === 'frame' && record.payload.expired) card.append(node('p', 'help-text', '원본 이미지 보관 기간이 지났어요. 연결된 대화와 경험은 유지해요.'));
    if (record.kind === 'answer' && record.source === 'model') card.append(node('p', 'help-text', record.payload.automatic ? '자동 분석 후보예요. 사용자 확인 없이 확정 기억이나 해결 상태로 바꾸지 않아요.' : 'AI 해석은 검토할 수 있는 답변으로 저장돼요.'));
    return card;
  }));
  if (!visible.length) $('#record-list').append(node('p', 'help-text', '아직 기록이 없거나 검색 결과가 없어요.'));
}
function stopRenderer() {
  captureRun++; clearInterval(timer); timer = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null; video.pause(); video.srcObject = null; pauseGap = false;
}
async function captureFrame(force = false) {
  if (captureBusy || !state.observation.observing || !video.videoWidth) return;
  if (stream?.getVideoTracks()[0]?.muted || video.readyState < 2) return;
  if (video.paused && !force) {
    if (!pauseGap) { pauseGap = true; await call('capture:gap', '영상이 일시정지되어 새 프레임 수집을 쉬었어요.'); }
    return;
  }
  pauseGap = false; captureBusy = true;
  const run = captureRun, worldId = state.activeWorld, sessionId = state.observation.sessionId;
  try {
    const ratio = Math.min(1, 1600 / video.videoWidth, 900 / video.videoHeight);
    canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const result = await call('capture:frame', { worldId, sessionId, image: canvas.toDataURL('image/jpeg', 0.78), videoTime: $('#source-kind').value === 'video' ? video.currentTime : null, force });
    if (!result || run !== captureRun || worldId !== state.activeWorld) return;
    if (result.gap) { $('#last-observation').textContent = '유효한 화면을 확인하지 못했어요'; return; }
    state.observation.lastFrame = result.capturedAt;
    $('#last-observation').textContent = `마지막 캡처 ${time(result.capturedAt)}`;
    $('#frame-time').textContent = $('#source-kind').value === 'video' ? `영상 ${videoTime(video.currentTime)} · 현재 상태 아님` : time(result.capturedAt);
    if (result.record) { state.records = [result.record, ...state.records.filter(r => r.id !== result.record.id)]; if (view === 'memory') renderMemory(); if (force) toast('이 월드의 근거 화면으로 기록했어요.'); }
  } finally { captureBusy = false; }
}
async function startCapture() {
  if (state.observation.observing) { render(await call('capture:stop')); return; }
  const replay = $('#source-kind').value === 'video';
  if (!replay && !selectedWindow) { await chooseSource(); return; }
  if (replay && !state.reference) { render(await call('video:import')); if (!state.reference) return; }
  render(await call('capture:start', { source: replay ? 'video' : selectedWindow.id }));
  const run = captureRun;
  try {
    pinnedFrame = null; pinnedAnswer = null; $('#open-evidence').disabled = true; $('#screen-empty').hidden = true; $('#evidence-image').hidden = true; $('#annotations').replaceChildren(); video.hidden = false;
    video.controls = replay;
    $('#frame-label').textContent = replay ? '리플레이 · 실시간 아님' : '실시간 · 선택한 창';
    $('#screen-note').textContent = replay ? '영상 당시의 화면이에요. 재생·일시정지·탐색할 수 있어요.' : '선택한 게임 창만 관찰해요. 원격 분석은 별도로 허용한 경우에만 실행해요.';
    if (replay) { if (video.src !== state.reference.url) video.src = state.reference.url; if (video.ended) video.currentTime = 0; }
    else {
      video.removeAttribute('src');
      const captured = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: { frameRate: 1, width: { max: 1600 }, height: { max: 900 } } });
      if (run !== captureRun) { captured.getTracks().forEach(t => t.stop()); return; }
      stream = captured; video.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = safe(async () => { render(await call('capture:stop')); toast('선택한 창의 캡처가 끝났어요.'); });
      track.onmute = safe(async () => { $('#last-observation').textContent = '선택한 창에 관찰 공백이 생겼어요'; await call('capture:gap', '선택한 창의 화면을 수집할 수 없어 관찰 공백이 생겼어요.'); });
    }
    await video.play();
    if (run !== captureRun) return;
    await captureFrame(true);
    timer = setInterval(() => captureFrame().catch(error => { toast(error.message); call('capture:stop').then(render).catch(() => {}); }), 1000);
  } catch (error) { render(await call('capture:stop')); throw new Error(`화면 수집을 시작하지 못했어요. ${error.message}`); }
}
async function chooseSource() {
  if ($('#source-kind').value === 'video') { render(await call('video:import')); return; }
  const sources = await call('capture:sources');
  $('#source-list').replaceChildren(...sources.map(source => {
    const button = node('button'), image = node('img'); image.src = source.thumbnail; image.alt = `${source.name} 창 미리보기`; button.append(image, document.createTextNode(source.name));
    button.onclick = () => { selectedWindow = source; $('#source-name').textContent = source.name; $('#source-dialog').close(); toast('관찰 범위를 선택했어요. “관찰 시작”을 눌러주세요.'); }; return button;
  }));
  if (!sources.length) $('#source-list').append(node('p', 'help-text', '선택할 수 있는 창이 없어요. 게임을 창 모드로 실행한 뒤 다시 확인해주세요.'));
  $('#source-dialog').showModal();
}

document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => setView(button.dataset.view); });
document.querySelectorAll('[data-intent]').forEach(button => { button.onclick = safe(async () => {
  $('#case-tools').open = true;
  const result = await call('chat:local', button.dataset.intent); render(result.snapshot);
  if (button.dataset.intent === 'fleet') { $('#fleet-card').open = true; $('#fleet-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  if (button.dataset.intent === 'setup') $('#guide-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}); });
$('#companion-mode').onchange = safe(async event => { const mode = event.target.value; try { render(await call('companion:save', { mode })); } catch (error) { event.target.value = state.settings.mode; throw error; } });
$('#edit-companion').onclick = () => { const form = $('#companion-form'); for (const [key, value] of Object.entries(state.settings.profile)) form.elements[key].value = value; $('#companion-dialog').showModal(); };
$('#close-companion-dialog').onclick = () => $('#companion-dialog').close();
$('#companion-form').onsubmit = safe(async event => { event.preventDefault(); const profile = Object.fromEntries(new FormData(event.target)); render(await call('companion:save', { profile })); $('#companion-dialog').close(); toast('우리 대화의 분위기를 저장했어요.'); });
$('#compact-toggle').onclick = safe(async () => { setView('play'); render(await call('window:compact', !state.compact)); });
$('#overlay-home').onclick = safe(async () => render(await call('window:compact', false)));
$('#overlay-return').onclick = safe(async () => render(await call('window:input', false)));
for (const action of ['minimize', 'maximize', 'close']) $(`#window-${action}`).onclick = safe(() => call('window:action', action));
$('#compact-stop').onclick = safe(async () => render(await call('capture:stop')));
$('#open-example').onclick = safe(async () => { render(await call('world:example')); $('#source-kind').value = 'video'; render(state); setView('play'); $('#case-tools').open = true; });
$('#open-memory').onclick = () => setView('memory');
$('#world-select').onchange = safe(async event => { render(await call('world:select', event.target.value)); $('#fleet-result').replaceChildren(); });
$('#new-world').onclick = () => $('#world-dialog').showModal();
$('#close-world-dialog').onclick = () => $('#world-dialog').close();
$('#world-form').onsubmit = safe(async event => { event.preventDefault(); const input = Object.fromEntries(new FormData(event.target)); render(await call('world:create', input)); event.target.reset(); $('#world-dialog').close(); $('#fleet-result').replaceChildren(); });
$('#save-goal').onclick = safe(async () => { render(await call('world:update', { goal: $('#goal').value })); toast('이번 월드의 목표를 기억했어요.'); });
$('#previous-step').onclick = safe(async () => render(await call('world:update', { step: Math.max(0, world().state.step - 1) })));
$('#next-step').onclick = safe(async () => { if (world().state.step < 5) render(await call('world:update', { step: world().state.step + 1 })); else { const result = await call('chat:local', 'verify'); render(result.snapshot); } });
$('#fleet-form').onsubmit = safe(async event => {
  event.preventDefault(); const input = Object.fromEntries(new FormData(event.target));
  const { result, snapshot } = await call('fleet:calculate', input); render(snapshot);
  const box = node('div', 'fleet-result-box'); box.append(node('strong', '', `최소 ${result.ships}척 후보`), node('p', '', `한 왕복에 필요한 홉 ${result.required.toLocaleString('ko-KR')}t ÷ 한 척의 홉 적재량 ${result.capacity.toLocaleString('ko-KR')}t → 올림`));
  if (result.productionShortfall) box.append(node('p', 'warning', '생산량이 소비량보다 적어요. 이 척수는 운송 용량만 계산한 값이며, 배 추가로 공급 부족이 해결되지 않아요.'));
  else if (result.production === null) box.append(node('p', 'warning', '홉 생산량은 미확인이에요. 생산이 소비를 충족한다는 조건에서의 계산이에요.'));
  box.append(node('p', '', `왕복 ${result.cycle}분 동안 소비할 홉은 ${result.buffer.toLocaleString('ko-KR')}t예요. 도착 간격을 버틸 재고와 항구 대기·하역 상태를 따로 확인해요. 입력한 수치가 바뀌면 다시 계산해주세요.`));
  $('#fleet-result').replaceChildren(box);
});
$('#source-kind').onchange = () => render(state);
$('#choose-source').onclick = safe(chooseSource);
$('#toggle-capture').onclick = safe(startCapture);
$('#close-source-dialog').onclick = () => $('#source-dialog').close();
$('#capture-now').onclick = safe(() => captureFrame(true));
$('#toggle-marks').onclick = () => { marksVisible = !marksVisible; $('#toggle-marks').textContent = marksVisible ? '표시 숨기기' : '표시 보기'; $('#toggle-marks').setAttribute('aria-pressed', String(marksVisible)); if (pinnedFrame) drawMarks(pinnedFrame); };
video.onended = safe(async () => { if (state.observation.observing && $('#source-kind').value === 'video') { render(await call('capture:stop')); toast('리플레이가 끝났어요. 마지막 근거 화면을 남겼어요.'); } });
$('#chat-form').onsubmit = safe(async event => {
  event.preventDefault();
  if (!state.settings.hasKey || !state.settings.analysisConsent) { if (state.compact) render(await call('window:compact', false)); setView('settings'); toast('대화를 시작하려면 AI를 연결하고 전송을 허용해주세요.'); return; }
  if (asking) return;
  const question = $('#question').value.trim(); if (!question) return;
  asking = true; $('#analysis-state').hidden = false; $('#send-question').disabled = true;
  const worldId = state.activeWorld, evidenceId = focusedEvidenceId || null;
  $('#question').value = ''; focusedEvidenceId = null; $('#question-reference').hidden = true;
  const pending = node('div', 'user-bubble pending', question); $('#messages').append(pending); $('#messages').scrollTop = $('#messages').scrollHeight;
  try { await Promise.all([call('chat:ask', {question,evidenceId}), state.compact ? call('window:input', false).then(render) : Promise.resolve()]); }
  catch (error) { if (state.activeWorld === worldId && !$('#question').value) { $('#question').value = question; focusedEvidenceId = evidenceId; $('#question-reference').hidden = !evidenceId; } throw error; }
  finally { pending.remove(); asking = false; $('#analysis-state').hidden = true; $('#send-question').disabled = false; await call('chat:active', false); }
});
$('#question').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!asking) $('#chat-form').requestSubmit(); } };
$('#question').oninput = () => { if (Date.now() - activePing > 3000) { activePing = Date.now(); call('chat:active', true).catch(() => {}); } };
$('#question').onfocus = () => { if ($('#question').value) call('chat:active', true).catch(() => {}); };
$('#question').onblur = () => call('chat:active', false).catch(() => {});
$('#cancel-analysis').onclick = safe(() => call('chat:cancel'));
$('#note-form').onsubmit = safe(async event => { event.preventDefault(); render(await call('record:add', $('#new-note').value)); $('#new-note').value = ''; });
$('#close-record-dialog').onclick = () => $('#record-dialog').close();
$('#record-form').onsubmit = safe(async event => { event.preventDefault(); render(await call('record:edit', { id: editingRecord, text: $('#edit-note').value })); $('#record-dialog').close(); toast('기억을 수정했어요. 이전 내용을 쓴 답변도 함께 정리했어요.'); });
$('#new-experience').onclick = () => openExperience();
$('#close-experience-dialog').onclick = () => $('#experience-dialog').close();
$('#experience-form').onsubmit = safe(async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const content = Object.fromEntries(['title', 'hypothesis', 'action', 'check', 'conditions'].map(k => [k, form.elements[k].value]));
  let next;
  if (!editingExperience) next = await call('experience:create', { ...content, evidence_ids: pinnedFrame?.payload.available ? [pinnedFrame.id] : [] });
  else {
    const changes = { id: editingExperience.id, expected_revision: editingExperience.payload.revision, ...(experienceMode === 'result' ? { status: 'completed' } : content) };
    if (experienceMode === 'result' || editingExperience.payload.status === 'completed') { changes.result = form.elements.result.value; changes.outcome = form.elements.outcome.value; }
    next = await call('experience:update', changes);
  }
  $('#experience-dialog').close(); editingExperience = null; render(next);
  toast('이 플레이의 경험으로 남겼어요. 다음 대화에서 조건을 확인하며 참고해요.');
});
let searchTimer, searchRevision = 0;
$('#memory-search').oninput = () => { clearTimeout(searchTimer); const revision = ++searchRevision; searchTimer = setTimeout(safe(async () => { const query = $('#memory-search').value.trim(), id = state.activeWorld; const results = query ? await call('record:search', query) : state.records; if (revision === searchRevision && id === state.activeWorld) renderMemory(results); }), 200); };
$('#export-world').onclick = safe(async () => { if (await call('world:export')) toast('키를 제외한 월드 기록과 근거 이미지를 내보냈어요.'); });
$('#delete-world').onclick = safe(async () => { if (window.confirm('이 월드의 목표·대화·기억·이미지를 모두 삭제할까요?')) { render(await call('world:delete')); $('#fleet-result').replaceChildren(); } });
let availableModels = [];
$('#load-models').onclick = safe(async () => {
  const button = $('#load-models'); button.disabled = true; button.textContent = '목록을 가져오는 중…';
  try {
    availableModels = await call('models:list');
    const current = $('#model-select').value;
    $('#model-select').replaceChildren(node('option', '', '모델을 선택해주세요'), ...availableModels.map(m => { const option = node('option', '', m.name); option.value = m.id; return option; }));
    $('#model-select').options[0].value = '';
    $('#model-select').value = current;
    toast(`이미지·구조화 답변을 지원하는 모델 ${availableModels.length}개를 확인했어요.`);
  } finally { button.disabled = false; button.textContent = '모델 목록 가져오기 ↻'; }
});
$('#model-select').onchange = () => {
  const model = availableModels.find(m => m.id === $('#model-select').value);
  $('#model-price').textContent = model?.pricing?.prompt != null && model?.pricing?.completion != null ? `텍스트 토큰 100만 개 기준: 입력 $${(Number(model.pricing.prompt) * 1e6).toFixed(2)}, 출력 $${(Number(model.pricing.completion) * 1e6).toFixed(2)} · 이미지·기타 비용과 실제 청구는 제공자 정보 확인` : '이 모델의 가격은 아직 확인하지 못했어요.';
};
$('#settings-form').onsubmit = safe(async event => {
  event.preventDefault(); const button = $('#save-settings'); button.disabled = true; button.textContent = '연결을 확인하는 중…';
  try { render(await call('settings:save', { key: $('#api-key').value, model: $('#model-select').value, analysisConsent: $('#analysis-consent').checked, autoAnalyze: $('#auto-analyze').checked, maxRequests: $('#request-limit').value, analysisInterval: $('#analysis-interval').value })); $('#api-key').value = ''; renderSettings(true); toast('연결과 전송 설정을 저장했어요.'); }
  finally { button.disabled = false; button.textContent = '저장하고 연결 확인'; }
});
$('#delete-key').onclick = safe(async () => { render(await call('key:delete')); $('#api-key').value = ''; renderSettings(true); toast('저장된 키를 삭제하고 원격 분석을 껐어요.'); });
$('#close-evidence').onclick=()=>$('#evidence-dialog').close();
$('#open-evidence').onclick=()=>{if(pinnedFrame) openEvidence(pinnedFrame,null,pinnedAnswer);};
$('#question-reference').onclick=()=>{focusedEvidenceId=null;$('#question-reference').hidden=true;};
$('#correct-evidence').onclick=()=>{focusedEvidenceId=correctionFrame.id;$('#question').value=`“${correctionLabel}”을 잘못 짚었어. 이 기록 화면을 다시 확인해줘.`;$('#evidence-dialog').close();$('#question').focus();};
window.companion.on('capture:stop', () => { stopRenderer(); if (state) { state.observation.observing = false; render(state); } });
window.companion.on('capture:now', () => captureFrame(true).catch(error => toast(error.message)));
window.companion.on('data:changed', render);
window.companion.on('window:changed', next => { if (next.compact && !next.overlay.interactive) $('#toast').hidden = true; render(next); });
window.companion.on('window:error', toast);
window.companion.on('chat:focus', () => { setView('play'); $('#question').focus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && state?.compact && !event.isComposing) { event.preventDefault(); event.stopPropagation(); document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); call('window:input', false).then(render).catch(error => toast(error.message)); } }, true);
window.companion.on('analysis:error', message => { toast(message); $('#last-observation').textContent = '원격 분석을 중지했어요 · 로컬 관찰은 별도'; });
window.addEventListener('beforeunload', stopRenderer);
call('bootstrap').then(data => { render(data); window.companionReady = true; }).catch(error => toast(error.message));
