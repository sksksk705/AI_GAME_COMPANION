const { app, BrowserWindow, ipcMain, desktopCapturer, session, protocol, net, nativeImage, safeStorage, dialog, powerMonitor, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { openStore } = require('./store.cjs');
const { ROUTE_STEPS, PLAN_STATES, TRANSITIONS, text, calculateFleet, frameDifference, localAnswer, companionProfile, conversation, proactiveDecision } = require('./core.cjs');
const provider = require('./provider.cjs');
const { EXPERIENCE_STATES, EXPERIENCE_TRANSITIONS, OUTCOMES } = require('./learning.cjs');
const buddy = require('./buddy.cjs');
const reactions = require('./reactions.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'companion', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const smoke = process.argv.includes('--smoke');
if (smoke) app.setPath('userData', path.join(__dirname, '../.local', `smoke-${randomUUID()}`));
app.setName('AI Game Companion');
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', async (_event, args) => { if (win && !win.isDestroyed()) { if (args.includes('--overlay')) { if (!overlayInteractive) rememberForeground(); await setCompact(true); await setOverlayInput(false); } else if (compact) await setOverlayInput(true); else { win.restore(); win.show(); win.focus(); } } });
let win, store, directory, activeWorld, referenceVideo, selectedSource, job, fullBounds, overlayBounds, fullMaximized;
let overlayInteractive = false;
let buddyRegions = [], buddyMouseActive = false, captureContinuity = 0, nextAutomaticAt = 0, silenceCount = 0;
let nativeWindows, previousForeground = 0n, returningForeground = false, focusRevision = 0, overlayTransitions = 0;
const shortcuts = { chat: null, visibility: null };
let referenceRevision = randomUUID();
let observing = false, compact = false, composerBusy = false, epoch = 0, lastSaved = 0, lastAnalysis = 0, lastInteraction = 0, lastSignature, frames = [], modelList = [], remoteBlocked = false;
let dismissedEvents = new Set();
let settings = { model: '', analysisConsent: false, autoAnalyze: false, maxRequests: 20, analysisInterval: 30, mode: 'quiet', profile: { name: '동료', style: 'calm', tone: 'casual', preferences: '' } };
const referenceName = 'Anno 1800 2026-10-06 22-25-26.mp4';
const referenceMarks = [{ x: .357, y: .666, width: .07, height: .169, label: '① 선택한 교역소' }, { x: .699, y: .894, width: .123, height: .034, label: '② 홉 재고 · 영상 당시' }, { x: .086, y: .96, width: .035, height: .04, label: '③ 무역로 메뉴 · 기본 단축키 T' }];

function emit(channel, value) { if (win && !win.isDestroyed()) win.webContents.send(channel, value); }
function loadKey() {
  const file = path.join(directory, 'key.enc');
  if (!fs.existsSync(file)) return null;
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS 보안 저장소를 사용할 수 없어요.');
  try { return safeStorage.decryptString(fs.readFileSync(file)); }
  catch { throw new Error('저장된 키를 읽을 수 없어요. 설정에서 다시 연결해주세요.'); }
}
function saveSettings() {
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...settings, activeWorld }));
  fs.renameSync(`${file}.tmp`, file);
}
function todayUsage() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
  const start = new Date(`${today}T00:00:00+09:00`).toISOString();
  const requests = store.usageSince(start).map(r => r.payload);
  const costs = requests.map(r => r.usage?.cost).filter(c => typeof c === 'number' && Number.isFinite(c));
  return { requests: requests.length, reportedCost: costs.length ? costs.reduce((a, b) => a + b, 0) : null, unknown: requests.length - costs.length };
}
function usedToday() { return todayUsage().requests; }
function publicRecord(row) {
  const record = { ...row, payload: { ...row.payload } };
  if (row.kind === 'frame') {
    const file = path.join(directory, 'evidence', path.basename(row.payload.filename));
    record.payload.available = !row.payload.expired && fs.existsSync(file);
    record.payload.url = record.payload.available ? `companion://app/evidence/${row.world_id}/${row.id}` : null;
    delete record.payload.filename;
  }
  return record;
}
function snapshot() {
  const records = store.snapshotRecords(activeWorld);
  return { worlds: store.worlds(), activeWorld, records: records.map(publicRecord), compact, overlay: { interactive: overlayInteractive, shortcuts }, steps: ROUTE_STEPS, planStates: PLAN_STATES, transitions: TRANSITIONS, experienceStates: EXPERIENCE_STATES, experienceTransitions: EXPERIENCE_TRANSITIONS, outcomes: OUTCOMES,
    settings: { ...settings, hasKey: fs.existsSync(path.join(directory, 'key.enc')), usedToday: usedToday(), usage: todayUsage(), secureStorage: safeStorage.isEncryptionAvailable() },
    reference: referenceVideo ? { name: path.basename(referenceVideo), url: `companion://app/media/reference.mp4?v=${referenceRevision}` } : null,
    observation: { observing, source: selectedSource?.name || null, sessionId: selectedSource?.sessionId || null, lastFrame: frames.at(-1)?.capturedAt || null, remoteBlocked } };
}
function initializeWindowsFocus() {
  if (process.platform !== 'win32') return;
  const user32 = require('koffi').load('user32.dll');
  nativeWindows = {
    get: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    set: user32.func('int __stdcall SetForegroundWindow(uintptr_t window)'),
    valid: user32.func('int __stdcall IsWindow(uintptr_t window)'),
    style: user32.func('int __stdcall GetWindowLongW(uintptr_t window, int index)')
  };
}
function windowHandle() { const handle = win.getNativeWindowHandle(); return handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE()); }
function currentForeground() { return BigInt(nativeWindows?.get() || 0); }
function rememberForeground() {
  const current = currentForeground();
  if (current !== windowHandle() && nativeWindows?.valid(current)) previousForeground = current;
  returningForeground = false;
}
function prepareForegroundReturn(requested) {
  if (!requested) rememberForeground();
  const current = currentForeground();
  returningForeground = !!nativeWindows?.valid(previousForeground) && (requested || current === windowHandle() || current === previousForeground || current === 0n);
}
async function activateForeground(handle) {
  if (!nativeWindows?.valid(handle)) return false;
  if (currentForeground() === handle) return true;
  // Call from the app receiving the user's input: a child process lacks Windows foreground rights.
  nativeWindows.set(handle);
  for (let i = 0; i < 50; i++) { if (currentForeground() === handle) return true; await new Promise(r => setTimeout(r, 10)); }
  return false;
}
async function restoreForeground() {
  const requested = returningForeground; returningForeground = false;
  if (!nativeWindows?.valid(previousForeground) || (!requested && currentForeground() !== windowHandle() && currentForeground() !== 0n)) return true;
  return activateForeground(previousForeground);
}
function updateBuddyMouse() {
  if (!win || win.isDestroyed() || !compact || overlayInteractive || !win.isVisible()) return;
  const active = buddy.hitsBuddy(screen.getCursorScreenPoint(), win.getBounds(), buddyRegions);
  if (active !== buddyMouseActive) {
    buddyMouseActive = active;
    // The avatar accepts mouse clicks without becoming focusable. Empty space still reaches the game.
    win.setIgnoreMouseEvents(!active, { forward: true });
  }
}
async function setOverlayInput(active, visible = true, returnToGame = true) {
  if (!compact) return;
  overlayTransitions++;
  try {
    const revision = ++focusRevision;
    if (active) rememberForeground();
    if (!active) prepareForegroundReturn(returnToGame);
    if (revision !== focusRevision || !compact) return;
    // The avatar provides mouse access even when every question shortcut is occupied.
    overlayInteractive = active;
    buddyRegions = []; buddyMouseActive = overlayInteractive;
    win.setIgnoreMouseEvents(!overlayInteractive, { forward: true });
    win.setFocusable(overlayInteractive);
    win.setSkipTaskbar(true);
    win.setOpacity(1);
    const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    win.setBounds(buddy.overlayBounds(bounds, area, overlayInteractive));
    composerBusy = overlayInteractive; lastInteraction = Date.now();
    emit('window:changed', snapshot());
    if (visible) { if (overlayInteractive) { win.show(); win.focus(); await activateForeground(windowHandle()); if (revision === focusRevision && compact && overlayInteractive) emit('chat:focus', null); } else win.showInactive(); }
    else win.hide();
    if (!overlayInteractive && revision === focusRevision && !await restoreForeground()) emit('window:error', '게임 창으로 돌아가지 못했어요. 게임 창을 한 번 클릭해주세요.');
  } finally { overlayTransitions--; }
}
async function setCompact(next) {
  if (next === compact) return;
  if (next) rememberForeground();
  compact = next;
  if (next) {
    fullMaximized = win.isMaximized(); fullBounds = win.getNormalBounds();
    if (fullMaximized) win.unmaximize();
    win.setMinimumSize(120, 120); win.setResizable(false); win.setMaximizable(false);
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(410, area.width), height = Math.min(280, area.height);
    const saved = overlayBounds && screen.getAllDisplays().some(d => overlayBounds.x >= d.workArea.x && overlayBounds.y >= d.workArea.y && overlayBounds.x + width <= d.workArea.x + d.workArea.width && overlayBounds.y + height <= d.workArea.y + d.workArea.height);
    win.setBounds(saved ? buddy.overlayBounds(overlayBounds, screen.getDisplayMatching(overlayBounds).workArea, false) : { x: area.x + Math.max(0, area.width - width - 16), y: area.y + Math.max(0, area.height - height - 32), width, height });
    // ponytail: desktop composition supports windowed/borderless games; exclusive fullscreen needs a game-specific integration.
    win.setAlwaysOnTop(true, 'screen-saver');
    return setOverlayInput(false);
  } else {
    focusRevision++; overlayBounds = win.getBounds(); overlayInteractive = false; buddyRegions = []; buddyMouseActive = false;
    win.setIgnoreMouseEvents(false); win.setFocusable(true); win.setSkipTaskbar(false); win.setOpacity(1);
    win.setAlwaysOnTop(false); win.setResizable(true); win.setMaximizable(true); win.setMinimumSize(1080, 720);
    if (fullBounds) win.setBounds(fullBounds);
    if (fullMaximized) win.maximize();
    emit('window:changed', snapshot()); win.show(); win.focus();
  }
}
async function toggleChat() {
  if (!compact) { await setCompact(true); await setOverlayInput(true); }
  else await setOverlayInput(!overlayInteractive || !win.isVisible() || currentForeground() !== windowHandle());
}
async function toggleOverlayVisibility() {
  if (!compact) await setCompact(true);
  else { if (!overlayInteractive) rememberForeground(); await setOverlayInput(false, !win.isVisible()); }
}
function registerShortcut(candidates, callback) {
  for (const accelerator of candidates) if (globalShortcut.register(accelerator, callback)) return accelerator;
  return null;
}
function stopObservation(reason = '사용자가 관찰을 중지했어요.') {
  if (observing) store.add(activeWorld, 'session', 'app', { text: reason, status: 'stopped' });
  observing = false; selectedSource = null; frames = []; lastSignature = null; dismissedEvents.clear(); captureContinuity++; nextAutomaticAt = 0; silenceCount = 0; composerBusy = false; epoch++;
  job?.controller.abort();
  emit('capture:stop', reason);
}
function decodeFrame(data) {
  if (typeof data !== 'string' || data.length > 2800000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data)) throw new Error('화면 이미지 형식이나 크기를 확인해주세요.');
  const bytes = Buffer.from(data.split(',')[1], 'base64'), image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width > 1920 || size.height > 1080 || size.width < 1 || size.height < 1) throw new Error('화면 크기는 최대 1920×1080이어야 해요.');
  const bitmap = image.resize({ width: 32, height: 18 }).toBitmap();
  const signature = [];
  for (let i = 0; i < bitmap.length; i += 4) signature.push(Math.round((bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3));
  return { bytes, size, signature };
}
function saveFrame(frame) {
  const existing = store.records(frame.worldId, 10).find(r => r.kind === 'frame' && r.payload.capturedAt === frame.capturedAt);
  if (existing) return existing;
  return store.frame(frame.worldId, frame.bytes, { source: frame.source, width: frame.size.width, height: frame.size.height, capturedAt: frame.capturedAt,
    videoTime: frame.videoTime, sessionId: frame.sessionId, continuity: frame.continuity, referenceName: frame.source === 'video' ? path.basename(referenceVideo || referenceName) : null, window: frame.window });
}
async function runAnalysis(question, automatic = false, evidenceId = null) {
  if (job) {
    if (automatic) return null;
    if (!job.automatic) throw new Error('진행 중인 답변을 기다리거나 취소해주세요.');
    const previous = job; previous.controller.abort(); await previous.promise.catch(() => {});
  }
  if (!settings.analysisConsent) throw new Error('설정에서 화면·기록의 AI 전송을 허용해주세요.');
  const key = loadKey();
  if (!key || !settings.model) throw new Error('설정에서 API 키와 이미지 지원 모델을 연결해주세요.');
  if (usedToday() >= settings.maxRequests) { remoteBlocked = true; throw new Error('오늘 앱 요청 한도에 도달했어요. 로컬 안내와 기억은 계속 사용할 수 있어요.'); }
  const world = store.world(activeWorld), contextEpoch = epoch;
  const latest = frames.at(-1);
  const pair = automatic && settings.mode === 'together' ? reactions.comparisonFrames(frames) : null;
  if (automatic && settings.mode === 'together' && !pair) return null;
  if (!pair && latest && Date.now() - Date.parse(latest.capturedAt) < 10000) saveFrame(latest);
  const { evidence: contextEvidence, recent, memories } = automatic && settings.mode === 'together' ? store.promptContext(world.id, world.goal) : store.analysisContext(world.id, question || world.goal, evidenceId);
  let evidence = contextEvidence;
  if (pair) {
    try { evidence = pair.map(frame => store.evidence(world.id, saveFrame(frame).id)); }
    catch (error) { remoteBlocked = true; emit('analysis:error', error.message); throw error; }
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
  const current = { controller, automatic, worldId: world.id };
  job = current; lastAnalysis = Date.now();
  const usageId = store.reserveUsage(settings.model, { status: 'sent', type: automatic ? 'automatic' : 'question' });
  let returnedUsage = false;
  current.promise = (async () => {
    try {
      const result = await provider.analyze({ key, model: settings.model, world, question, evidence, memories, profile: settings.profile, mode: settings.mode, automatic, recent, signal: controller.signal });
      const stillValid = !controller.signal.aborted && epoch === contextEpoch && activeWorld === world.id && store.world(world.id).revision === world.revision;
      store.updateUsage(usageId, { status: stillValid ? 'completed' : 'discarded', usage: result.usage, providerId: result.providerId }); returnedUsage = true;
      if (!stillValid) throw new Error('월드나 계획이 바뀌어 이전 답변을 폐기했어요.');
      remoteBlocked = false;
      const sampleStable = latest && frames.at(-1) && frameDifference(latest.signature, frames.at(-1).signature) <= 0.075;
      const suppressed = automatic ? (!win.isVisible() || win.isMinimized() ? 'hidden' : composerBusy || Date.now() - lastInteraction < 15000 ? 'user-active' : dismissedEvents.has(result.answer.event_key) ? 'dismissed' : proactiveDecision(result.answer, { mode: settings.mode, goal: world.goal, status: world.state.status, sampleStable, evidence, records: store.context(world.id), live: observing ? frames.at(-1) : null })) : null;
      if (automatic) { silenceCount = suppressed ? silenceCount + 1 : 0; nextAutomaticAt = Date.now() + reactions.nextDelay(settings.analysisInterval, silenceCount); }
      const observedAt = automatic && settings.mode === 'together' ? evidence.find(frame => frame.id === result.answer.observed_change?.after_evidence_id)?.payload.capturedAt || null : null;
      const record = store.saveAnswer(world.id, 'model', { question: automatic ? null : question, ...result.answer, automatic, delivered: !suppressed, suppressed, reaction_observed_at: observedAt, observation_session: automatic ? latest?.sessionId : null, contextRevision: world.revision, evidence: evidence.map(f => f.id), memory_refs: [...memories.map(r => r.id), ...conversation(recent).map(r => r.id)] });
      emit('data:changed', snapshot());
      if (!suppressed) emit('answer:ready', publicRecord(record));
      return publicRecord(record);
    } catch (error) {
      if (!controller.signal.aborted || timedOut) remoteBlocked = true;
      const message = controller.signal.aborted ? '요청이 취소되거나 시간이 초과됐어요. 이미 전송된 요청에는 비용이 발생할 수 있어요. 자동 재전송하지 않아요.' : error.message;
      if (!returnedUsage) store.updateUsage(usageId, { status: 'unknown' });
      if (!automatic || !controller.signal.aborted || timedOut) emit('analysis:error', message);
      throw new Error(message);
    } finally { clearTimeout(timeout); if (job === current) job = null; }
  })();
  return current.promise;
}

function handle(name, fn) {
  ipcMain.handle(name, async (event, input) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== 'companion://app/index.html') return { ok: false, error: '허용되지 않은 요청이에요.' };
    try { return { ok: true, value: await fn(input) }; }
    catch (error) { return { ok: false, error: error.message || '요청을 처리하지 못했어요.' }; }
  });
}

app.whenReady().then(async () => {
  directory = app.getPath('userData');
  store = openStore(directory); store.prune();
  const settingsFile = path.join(directory, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try { const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); settings.model = text(saved.model || '', 150); settings.analysisConsent = saved.analysisConsent === true; settings.autoAnalyze = saved.autoAnalyze === true; settings.maxRequests = Number.isInteger(saved.maxRequests) && saved.maxRequests >= 1 && saved.maxRequests <= 200 ? saved.maxRequests : 20;
      if ([15, 30, 60, 120].includes(saved.analysisInterval)) settings.analysisInterval = saved.analysisInterval;
      if (['quiet', 'watch', 'together'].includes(saved.mode)) settings.mode = saved.mode;
      if (saved.profile) settings.profile = companionProfile(saved.profile);
      if (store.worlds().some(w => w.id === saved.activeWorld)) activeWorld = saved.activeWorld;
    } catch { /* Invalid settings use safe defaults. */ }
  }
  const videoPath = path.join(__dirname, '..', referenceName);
  if (fs.existsSync(videoPath)) referenceVideo = videoPath;
  if (!store.worlds().length) {
    store.create('첫 플레이', '미지정', '');
  }
  // Preserve the earlier prototype's case; newly created Anno worlds use the common companion UI.
  for (const w of store.worlds()) if (w.state.scenario === undefined && w.name === '맥주를 위한 홉 섬' && w.game === 'anno1800') store.db.prepare('UPDATE worlds SET state=? WHERE id=?').run(JSON.stringify({ ...w.state, scenario: 'anno-hops' }), w.id);
  activeWorld ||= store.worlds()[0].id;
  const assets = new Set(['index.html', 'renderer.js', 'style.css']);
  protocol.handle('companion', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    const file = url.pathname.slice(1);
    if (assets.has(file)) return net.fetch(pathToFileURL(path.join(__dirname, file)).toString());
    if (file === 'media/reference.mp4' && referenceVideo) return net.fetch(pathToFileURL(referenceVideo).toString(), { headers: request.headers });
    if (url.pathname.startsWith('/evidence/')) {
      const parts = url.pathname.split('/');
      if (parts.length !== 4 || parts[2] !== activeWorld) return new Response('Not found', { status: 404 });
      try { return net.fetch(pathToFileURL(store.evidence(parts[2], parts[3]).file).toString()); } catch { return new Response('Evidence expired', { status: 404 }); }
    }
    return new Response('Not found', { status: 404 });
  });
  win = new BrowserWindow({ width: 1540, height: 1020, minWidth: 1080, minHeight: 720, frame: false, transparent: true, hasShadow: false, show: !smoke && !process.argv.includes('--overlay'), backgroundColor: '#00000000', title: '동료 · AI Game Companion', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  initializeWindowsFocus();
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', () => stopObservation('동료 창이 닫혀 관찰을 중지했어요.'));
  win.on('blur', () => setImmediate(() => { if (!win.isDestroyed() && !overlayTransitions && compact && overlayInteractive && currentForeground() !== windowHandle()) setOverlayInput(false, win.isVisible(), false); }));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(contents === win.webContents && observing && !!selectedSource && ['media', 'display-capture'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === win.webContents && observing && !!selectedSource && ['media', 'display-capture'].includes(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!observing || !selectedSource || selectedSource.id === 'video' || request.frame !== win.webContents.mainFrame) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === selectedSource.id);
      if (!source) { stopObservation('선택한 창을 찾을 수 없어 관찰을 중지했어요.'); return callback({}); }
      callback({ video: source });
    } catch { stopObservation('창 캡처를 시작하지 못했어요.'); callback({}); }
  });
  for (const event of ['lock-screen', 'suspend']) powerMonitor.on(event, () => stopObservation('기기가 잠기거나 대기 상태로 전환되어 관찰을 중지했어요.'));
  globalShortcut.register('CommandOrControl+Shift+Space', () => { if (observing) emit('capture:now', null); });
  shortcuts.chat = registerShortcut(['CommandOrControl+Shift+G', 'CommandOrControl+Shift+F8'], toggleChat);
  shortcuts.visibility = registerShortcut(['CommandOrControl+Shift+H', 'CommandOrControl+Shift+F9'], toggleOverlayVisibility);
  const buddyMouseTimer = setInterval(updateBuddyMouse, 80);
  win.on('closed', () => { clearInterval(buddyMouseTimer); });

  handle('bootstrap', () => snapshot());
  handle('companion:save', input => {
    const profile = input.profile === undefined ? settings.profile : companionProfile(input.profile);
    const mode = input.mode === undefined ? settings.mode : input.mode;
    if (!['quiet', 'watch', 'together'].includes(mode)) throw new Error('함께하는 방식을 확인해주세요.');
    if (mode === 'watch' && !store.world(activeWorld).goal) throw new Error('목표 감시를 켜기 전에 기억할 목표를 적어주세요.');
    settings.profile = profile; settings.mode = mode; nextAutomaticAt = 0; silenceCount = 0;
    epoch++; job?.controller.abort(); saveSettings(); return snapshot();
  });
  handle('chat:active', input => { composerBusy = input === true; lastInteraction = Date.now(); return true; });
  handle('chat:dismiss', id => {
    const record = store.record(activeWorld, id);
    if (record.kind !== 'answer' || !record.payload.automatic) throw new Error('동료가 먼저 건넨 말에만 사용할 수 있어요.');
    if (record.payload.event_key) dismissedEvents.add(record.payload.event_key);
    epoch++; job?.controller.abort(); store.amend(activeWorld, id, { ...record.payload, delivered: false, dismissed: true }, true); return snapshot();
  });
  handle('window:compact', async input => { await setCompact(input === true); return snapshot(); });
  handle('window:input', async input => { await setOverlayInput(input === true); return snapshot(); });
  handle('window:regions', input => { buddyRegions = buddy.hitRegions(input); updateBuddyMouse(); return true; });
  handle('window:action', async action => {
    if (!['minimize', 'maximize', 'close'].includes(action)) throw new Error('창 동작을 확인해주세요.');
    if (action === 'close') win.close();
    else if (action === 'minimize') {
      // If neither shortcut is available, keep a taskbar entry from which the user can return.
      if (compact && !shortcuts.chat && !shortcuts.visibility) { await setCompact(false); win.minimize(); }
      else if (compact) await setOverlayInput(false, false);
      else win.minimize();
    }
    else if (!compact) { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    return true;
  });
  handle('world:example', () => {
    stopObservation();
    const w = store.worlds().find(w => w.state.scenario === 'anno-hops') || store.create('맥주를 위한 홉 섬', 'anno1800', '홉 섬을 준비하고 메인섬으로 홉을 보내 맥주 생산을 시작하기', 'anno-hops');
    activeWorld = w.id;
    const framePath = path.join(__dirname, '../.local/frame-28.jpg');
    if (!store.records(w.id).some(r => r.kind === 'frame') && fs.existsSync(framePath)) {
      const decoded = nativeImage.createFromPath(framePath), size = decoded.getSize();
      store.frame(w.id, decoded.toJPEG(85), { source: 'video', width: size.width, height: size.height, videoTime: 28, referenceName, capturedAt: null,
        text: '첨부 영상 00:28: 소형 교역소와 홉 재고 7/75 표시를 확인했어요. 무역로와 생산·소비량은 미확인이에요.',
        annotations: referenceMarks });
    }
    const seed = store.records(w.id,500).find(r=>r.kind==='frame' && r.source==='video' && r.payload.videoTime===28 && r.payload.referenceName===referenceName && r.payload.text);
    if(seed && seed.payload.annotations?.length===2) store.amend(w.id,seed.id,{...seed.payload,annotations:referenceMarks});
    saveSettings(); return snapshot();
  });
  handle('world:create', input => { stopObservation(); const w = store.create(input.name, input.game, input.goal || ''); activeWorld = w.id; saveSettings(); return snapshot(); });
  handle('world:select', id => { store.world(id); stopObservation('월드가 바뀌어 관찰을 중지했어요.'); activeWorld = id; saveSettings(); return snapshot(); });
  handle('world:update', changes => { store.update(activeWorld, changes); epoch++; job?.controller.abort(); return snapshot(); });
  handle('world:delete', () => {
    stopObservation('월드를 삭제해 관찰을 중지했어요.');
    for (const r of store.records(activeWorld, -1)) { if (store.db.prepare('SELECT id FROM records WHERE id=? AND deleted_at IS NULL').get(r.id)) store.remove(activeWorld, r.id); }
    store.db.prepare('DELETE FROM records WHERE world_id=?').run(activeWorld);
    store.db.prepare('DELETE FROM record_search WHERE world_id=?').run(activeWorld);
    store.db.prepare('DELETE FROM worlds WHERE id=?').run(activeWorld);
    if (!store.worlds().length) store.create('첫 플레이', '미지정', '');
    activeWorld = store.worlds()[0].id; saveSettings(); return snapshot();
  });
  handle('record:add', value => { const note = text(value, 2000); if (!note) throw new Error('기억할 내용을 입력해주세요.'); epoch++; job?.controller.abort(); store.add(activeWorld, 'note', 'user', { text: note }); return snapshot(); });
  handle('experience:create', input => {
    store.createExperience(activeWorld, input);
    epoch++; job?.controller.abort(); return snapshot();
  });
  handle('experience:update', input => {
    const { id, ...changes } = input;
    const previous = store.record(activeWorld, id);
    if (previous.kind !== 'experience' || previous.payload.revision !== changes.expected_revision) throw new Error('경험이 바뀌었어요. 다시 열어서 수정해주세요.');
    if (changes.status === 'completed' && previous.payload.status === 'applied') {
      const latest = frames.at(-1);
      if (observing && latest?.source === 'window' && latest.worldId === activeWorld && Date.now() - Date.parse(latest.capturedAt) < 10000) {
        try { changes.after_evidence = [saveFrame(latest).id]; }
        catch (error) { if (!error.message.includes('보관 한도')) throw error; }
      }
    }
    store.updateExperience(activeWorld, id, changes);
    epoch++; job?.controller.abort(); return snapshot();
  });
  handle('record:edit', input => {
    const record = store.record(activeWorld, input.id), value = text(input.text, 2000);
    if (record.kind !== 'note' || record.source !== 'user' || !value) throw new Error('사용자가 추가한 기억만 수정할 수 있어요.');
    epoch++; job?.controller.abort(); store.amend(activeWorld, input.id, { text: value, editedAt: new Date().toISOString() }, true); return snapshot();
  });
  handle('record:delete', id => { epoch++; job?.controller.abort(); store.remove(activeWorld, id); frames = []; return snapshot(); });
  handle('record:search', q => store.search(activeWorld, q).map(publicRecord));
  handle('record:get', id => {
    const record = store.record(activeWorld, text(id, 100));
    if (record.kind !== 'frame') throw new Error('이미지 근거만 열 수 있어요.');
    return publicRecord(record);
  });
  handle('fleet:calculate', input => { if (store.world(activeWorld).state.scenario !== 'anno-hops') throw new Error('홉 운송 예제에서 사용하는 계산이에요.'); const result = calculateFleet(input); store.update(activeWorld, { inputs: input }); return { result, snapshot: snapshot() }; });
  handle('chat:local', intent => {
    if (store.world(activeWorld).state.scenario !== 'anno-hops') throw new Error('홉 운송 예제에서 사용하는 가이드예요.');
    if (!['setup', 'cargo', 'fleet', 'verify'].includes(intent)) throw new Error('안내 종류를 확인해주세요.');
    const answer = localAnswer(intent, store.world(activeWorld));
    const record = store.add(activeWorld, 'answer', 'guide', { question: { setup: '무역로를 어떻게 설정해요?', cargo: '무엇을 운송하면 좋을까요?', fleet: '배는 몇 척이 필요해요?', verify: '설정 후 무엇을 확인해요?' }[intent], ...answer });
    return { record: publicRecord(record), snapshot: snapshot() };
  });
  handle('chat:ask', input => { const question = text(typeof input === 'string' ? input : input?.question, 4000), evidenceId = typeof input === 'object' && input?.evidenceId != null ? text(input.evidenceId, 100) : null; if (!question) throw new Error('말할 내용을 입력해주세요.'); lastInteraction = Date.now(); return runAnalysis(question, false, evidenceId); });
  handle('chat:cancel', () => { job?.controller.abort(); return true; });
  handle('capture:sources', async () => (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } })).filter(s => s.name !== win.getTitle()).map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
  handle('capture:start', async input => {
    stopObservation();
    if (input.source === 'video') {
      if (!referenceVideo) throw new Error('리플레이할 영상을 선택해주세요.');
      selectedSource = { id: 'video', name: path.basename(referenceVideo) };
    } else {
      const id = text(input.source, 100);
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(s => s.id === id && s.name !== win.getTitle());
      if (!source) throw new Error('선택한 창을 찾을 수 없어요.');
      selectedSource = { id, name: source.name };
    }
    selectedSource.sessionId = randomUUID(); observing = true; lastSaved = 0; lastAnalysis = Date.now(); remoteBlocked = false;
    store.add(activeWorld, 'session', 'app', { text: selectedSource.id === 'video' ? '첨부 영상 리플레이 시작 · 실시간 관찰 아님' : `창 관찰 시작: ${selectedSource.name}`, status: 'started' });
    return snapshot();
  });
  handle('capture:stop', () => { stopObservation(); return snapshot(); });
  handle('capture:gap', input => { if (observing) { captureContinuity++; store.add(activeWorld, 'gap', 'app', { text: text(input, 200) }); if (job?.automatic) job.controller.abort(); } return true; });
  handle('capture:frame', async input => {
    if (!observing || input.worldId !== activeWorld || input.sessionId !== selectedSource.sessionId) return null;
    const { bytes, size, signature } = decodeFrame(input.image);
    if (signature.every(n => n < 3)) { captureContinuity++; if (job?.automatic) job.controller.abort(); return { gap: true }; }
    const source = selectedSource.id === 'video' ? 'video' : 'window';
    const videoTime = source === 'video' && typeof input.videoTime === 'number' && Number.isFinite(input.videoTime) && input.videoTime >= 0 ? input.videoTime : null;
    const frame = { bytes, size, signature, worldId: activeWorld, sessionId: selectedSource.sessionId, continuity: captureContinuity, source, videoTime, window: source === 'window' ? selectedSource.name : null, capturedAt: new Date().toISOString() };
    frames.push(frame); frames = frames.slice(-60);
    const changed = frameDifference(signature, lastSignature) > 0.075;
    lastSignature = signature;
    let record = null;
    // ponytail: whole-frame brightness differences include camera motion; use game-specific regions after measured misses.
    if (input.force === true || (changed && Date.now() - lastSaved >= 15000)) { record = saveFrame(frame); lastSaved = Date.now(); }
    if (settings.autoAnalyze && settings.mode !== 'quiet' && reactions.automaticAdmission({ settings, source, visible: win.isVisible() && !win.isMinimized(), busy: composerBusy || !!job, blocked: remoteBlocked,
      lastAnalysis, lastInteraction, nextAutomaticAt, pair: settings.mode === 'together' ? reactions.comparisonFrames(frames) : null,
      records: store.context(activeWorld), goal: store.world(activeWorld).goal })) {
      runAnalysis('전후 기록 화면에서 직접 확인한 새로운 게임 변화에만 짧게 반응하세요. 인사·조언·질문을 붙이지 말고, 의미 있는 변화가 없으면 침묵하세요.', true).catch(() => {});
    }
    return { capturedAt: frame.capturedAt, record: record ? publicRecord(record) : null };
  });
  handle('video:import', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '게임 영상', extensions: ['mp4', 'webm'] }] });
    if (result.canceled) return snapshot();
    const file = result.filePaths[0];
    if (!['.mp4', '.webm'].includes(path.extname(file).toLowerCase()) || fs.statSync(file).size > 500 * 1024 * 1024) throw new Error('500MB 이하의 MP4 또는 WebM 영상을 선택해주세요.');
    stopObservation('영상을 바꾸어 리플레이를 중지했어요.'); referenceVideo = file; referenceRevision = randomUUID(); return snapshot();
  });
  handle('models:list', async () => { modelList = await provider.models(); return modelList; });
  handle('settings:save', async input => {
    const nextModel = text(input.model || '', 150), maxRequests = Number(input.maxRequests), analysisInterval = Number(input.analysisInterval);
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 200) throw new Error('일일 요청 한도는 1~200회로 설정해주세요.');
    if (![15, 30, 60, 120].includes(analysisInterval)) throw new Error('자동 관찰 간격을 확인해주세요.');
    if (input.autoAnalyze && (!input.analysisConsent || !nextModel || (!input.key && !fs.existsSync(path.join(directory, 'key.enc'))))) throw new Error('자동 분석에는 모델 연결과 AI 전송 허용이 필요해요.');
    if (input.key || nextModel !== settings.model) {
      if (!input.analysisConsent) throw new Error('모델 연결 테스트 전에 AI 전송을 허용해주세요.');
      const key = input.key ? text(input.key, 300) : loadKey();
      if (!key || !key.startsWith('sk-or-')) throw new Error('OpenRouter API 키를 확인해주세요.');
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('OS 보안 저장소가 없어 키를 저장할 수 없어요.');
      if (!modelList.length) modelList = await provider.models();
      if (!modelList.some(m => m.id === nextModel)) throw new Error('이미지와 구조화 답변을 지원하는 모델을 목록에서 선택해주세요.');
      if (usedToday() >= settings.maxRequests) throw new Error('오늘 요청 한도에 도달해 연결 테스트를 진행할 수 없어요.');
      if (job) throw new Error('진행 중인 분석을 기다리거나 취소해주세요.');
      const testFile = path.join(directory, 'connection-test.jpg');
      const icon = nativeImage.createFromBitmap(Buffer.from([255, 255, 255, 255]), { width: 1, height: 1 });
      fs.writeFileSync(testFile, icon.toJPEG(80));
      const world = store.world(activeWorld), contextEpoch = epoch, controller = new AbortController();
      const current = { controller, automatic: false, worldId: world.id };
      const timeout = setTimeout(() => controller.abort(), 60000);
      job = current;
      const usageId = store.reserveUsage(nextModel, { status: 'sent', type: 'connection' });
      let connectionReported = false;
      current.promise = provider.analyze({ key, model: nextModel, world, question: '연결 테스트입니다. 이 작은 이미지의 색상만 짧게 설명하세요.', evidence: [{ id: 'connection-test', source: 'test', created_at: new Date().toISOString(), payload: { width: 1, height: 1 }, file: testFile }], memories: [], signal: controller.signal });
      try {
        const result = await current.promise;
        store.updateUsage(usageId, { status: 'completed', usage: result.usage, providerId: result.providerId }); connectionReported = true;
        if (controller.signal.aborted || epoch !== contextEpoch || activeWorld !== world.id) throw new Error('연결 중 설정이나 월드가 바뀌어 결과를 적용하지 않았어요.');
        const file = path.join(directory, 'key.enc');
        fs.writeFileSync(`${file}.tmp`, safeStorage.encryptString(key)); fs.renameSync(`${file}.tmp`, file);
        store.add(world.id, 'connection', 'provider', { text: '이미지 요청과 응답 형식 확인 완료', model: nextModel, usage: result.usage });
      } catch (error) { if (!connectionReported) store.updateUsage(usageId, { status: 'unknown' }); throw new Error(controller.signal.aborted ? '연결 요청이 중지됐어요. 이미 전송된 요청에 비용이 발생할 수 있어요.' : error.message); }
      finally { clearTimeout(timeout); if (job === current) job = null; fs.rmSync(testFile, { force: true }); }
    }
    epoch++; job?.controller.abort(); settings = { ...settings, model: nextModel, analysisConsent: input.analysisConsent === true, autoAnalyze: input.autoAnalyze === true, maxRequests, analysisInterval };
    remoteBlocked = false; nextAutomaticAt = 0; silenceCount = 0;
    if (!settings.analysisConsent) { job?.controller.abort(); remoteBlocked = true; }
    saveSettings(); return snapshot();
  });
  handle('key:delete', () => { job?.controller.abort(); epoch++; fs.rmSync(path.join(directory, 'key.enc'), { force: true }); settings.analysisConsent = false; settings.autoAnalyze = false; settings.model = ''; saveSettings(); return snapshot(); });
  handle('world:export', async () => {
    const result = await dialog.showSaveDialog(win, { defaultPath: 'companion-world.json', filters: [{ name: '월드 기록', extensions: ['json'] }] });
    if (result.canceled) return false;
    // ponytail: JSON export holds up to 300 images in memory; use a streamed archive if exports grow.
    const records = store.records(activeWorld, -1).map(r => r.kind === 'frame' ? { ...publicRecord(r), payload: { ...publicRecord(r).payload, url: null, image: fs.existsSync(path.join(directory, 'evidence', path.basename(r.payload.filename))) ? fs.readFileSync(path.join(directory, 'evidence', path.basename(r.payload.filename))).toString('base64') : null } } : r);
    fs.writeFileSync(result.filePath, JSON.stringify({ schema_version: 1, exported_at: new Date().toISOString(), world: store.world(activeWorld), records }, null, 2)); return true;
  });

  await win.loadURL('companion://app/index.html');
  if (!smoke && process.argv.includes('--overlay')) { await setCompact(true); console.log('OVERLAY READY', JSON.stringify(shortcuts)); }
  if (smoke) {
    let captureCheck, foregroundCheck, focusChoiceCheck;
    try {
      const genericId = activeWorld;
      const uiFixtures = [
        store.add(genericId, 'answer', 'model', { question: 'UI 검증용 · 오늘은 탐험만 하자', summary: 'UI 검증용 · 좋아, 천천히 둘러보자.', facts: [], suggestions: [], hypotheses: [], missing_information: [], annotations: [] }),
        store.add(genericId, 'answer', 'model', { automatic: true, delivered: false, summary: 'UI 검증용 · 침묵한 후보' }),
        store.add(genericId, 'answer', 'model', { automatic: true, delivered: true, summary: 'UI 검증용 · 멋진 풍경이네!', event_key: '풍경:도착' })
      ];
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
      const probe = `local-check-${randomUUID()}`, encrypted = safeStorage.encryptString(probe);
      if (encrypted.toString('utf8').includes(probe) || safeStorage.decryptString(encrypted) !== probe) throw new Error('OS encryption roundtrip failed');
      captureCheck = new BrowserWindow({ width: 640, height: 400, show: false, focusable: false, title: 'Companion capture check', webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
      await captureCheck.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Companion capture check</title><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><body style="margin:0;background:#345e48;color:#eef4e8;font:28px sans-serif;padding:50px"><h1>CAPTURE CHECK</h1><p>Local test window</p></body>'));
      captureCheck.showInactive(); win.show(); win.focus();
      win.setAlwaysOnTop(true,'screen-saver'); win.showInactive();
      // A real click on our own test window supplies Windows foreground rights; JS key events do not.
      const mouseApi=require('koffi').load('user32.dll'), koffi=require('koffi');
      koffi.struct('CompanionTestPoint',{x:'int32_t',y:'int32_t'});
      koffi.struct('CompanionTestRect',{left:'int32_t',top:'int32_t',right:'int32_t',bottom:'int32_t'});
      const getRect=mouseApi.func('int __stdcall GetWindowRect(uintptr_t window, _Out_ CompanionTestRect *rect)');
      const atPoint=mouseApi.func('uintptr_t __stdcall WindowFromPoint(CompanionTestPoint point)');
      const ancestor=mouseApi.func('uintptr_t __stdcall GetAncestor(uintptr_t window, uint32_t flag)');
      const cursor=mouseApi.func('int __stdcall GetCursorPos(_Out_ CompanionTestPoint *point)');
      const moveCursor=mouseApi.func('int __stdcall SetCursorPos(int x, int y)');
      const click=mouseApi.func('void __stdcall mouse_event(uint32_t flags, uint32_t x, uint32_t y, uint32_t data, uintptr_t extra)');
      const bounds={}, originalCursor={}; getRect(windowHandle(),bounds); cursor(originalCursor);
      const target={x:Math.round((bounds.left+bounds.right)/2),y:Math.round((bounds.top+bounds.bottom)/2)};
      if(BigInt(ancestor(atPoint(target),2))!==windowHandle()) throw Error('test window is covered; no mouse input sent');
      try { moveCursor(target.x,target.y); click(2,0,0,0,0); click(4,0,0,0,0); await new Promise(r=>setTimeout(r,100)); if(!await activateForeground(windowHandle())) throw Error('own test window focus denied'); }
      finally { moveCursor(originalCursor.x,originalCursor.y); win.setAlwaysOnTop(false); }
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const checkSource = sources.find(s => s.name === 'Companion capture check');
      if (!checkSource) throw new Error('Native test window not found');
      const result = await win.webContents.executeJavaScript(`(async () => {
        const pause = ms => new Promise(r => setTimeout(r, ms));
        const waitFor = async predicate => { for(let i=0;i<200;i++){ if(await predicate()) return; await pause(25); } throw Error('UI wait timed out'); };
        const api = async (name, input) => { const result = await window.companion.call(name, input); if(!result.ok) throw Error(result.error); return result.value; };
        await waitFor(() => window.companionReady);
        if(typeof require !== 'undefined') throw Error('Node exposed');
        render(await api('bootstrap'));
        const genericId=state.activeWorld;
        if(!document.querySelector('#case-tools').hidden) throw Error('case is the product default');
        if(!document.querySelector('#messages').textContent.includes('천천히 둘러보자') || !document.querySelector('#messages').textContent.includes('멋진 풍경')) throw Error('dialogue missing');
        if(document.querySelector('#messages').textContent.includes('침묵한 후보') || document.querySelectorAll('.user-bubble').length!==1) throw Error('automatic candidate or system prompt leaked into conversation');
        await api('chat:dismiss',state.records.find(r=>r.payload.event_key==='풍경:도착').id); render(await api('bootstrap'));
        if(document.querySelector('#messages').textContent.includes('멋진 풍경')) throw Error('dismissed reaction still visible');
        document.querySelector('#edit-companion').click();
        document.querySelector('#companion-form').elements.name.value='두리';
        document.querySelector('#companion-form').requestSubmit();
        await waitFor(()=>document.querySelector('#chat-name').textContent==='두리' && !document.querySelector('#companion-dialog').open);
        document.querySelector('#companion-mode').value='together'; document.querySelector('#companion-mode').dispatchEvent(new Event('change'));
        await waitFor(async ()=>(await api('bootstrap')).settings.mode==='together');
        document.querySelector('#compact-toggle').click();
        await waitFor(()=>document.body.classList.contains('compact'));
        render(await api('window:input',true));
        const composer=document.querySelector('#question').getBoundingClientRect();
        if(composer.right>innerWidth || composer.height<20 || composer.bottom>innerHeight) throw Error('overlay composer hidden or overflow');
        document.querySelector('#compact-toggle').click(); await waitFor(()=>!document.body.classList.contains('compact'));
        document.querySelector('#open-example').click();
        await waitFor(()=>!document.querySelector('#case-tools').hidden && state.activeWorld!==genericId);
        if(!document.querySelector('#guide-title').textContent) throw Error('guide missing');
        document.querySelector('[data-intent="cargo"]').click();
        await waitFor(() => document.querySelector('#messages').textContent.includes('생활물품'));
        const initial = await api('bootstrap'), firstId = initial.activeWorld;
        const form = document.querySelector('#fleet-form');
        for (const [key,value] of Object.entries({demand:'2',cycle:'10',slots:'1',perSlot:'50',production:'1'})) form.elements[key].value = value;
        form.requestSubmit();
        await waitFor(() => document.querySelector('#fleet-result').textContent.includes('최소 1척 후보'));
        if(!document.querySelector('#fleet-result').textContent.includes('생산량이 소비량보다 적')) throw Error('production shortfall warning missing');
        document.querySelector('#next-step').click();
        await waitFor(() => document.querySelector('#guide-title').textContent.includes('두 섬'));
        const buttons = () => [...document.querySelectorAll('#plan-actions button')];
        buttons().find(b=>b.textContent==='계획에 추가').click();
        await waitFor(() => document.querySelector('#plan-status').textContent==='수락');
        if(buttons().some(b=>b.textContent==='해결됐어요')) throw Error('acceptance treated as applied');
        buttons().find(b=>b.textContent==='적용했어요').click();
        await waitFor(() => document.querySelector('#plan-status').textContent.includes('효과 확인 중'));
        let replayed = false;
        if(initial.reference){
          document.querySelector('#toggle-capture').click();
          await waitFor(() => document.querySelector('#game-video').videoWidth > 0 && !document.querySelector('#game-video').paused);
          await pause(1400);
          const running = await api('bootstrap');
          if(!running.observation.observing || !running.observation.lastFrame) throw Error('replay capture failed');
          if(!running.records.some(r=>r.kind==='frame' && r.payload.width<=1600 && r.payload.capturedAt)) throw Error('replay evidence not persisted');
          const stale = await api('capture:frame', {worldId:firstId,sessionId:'old-session',image:'invalid'});
          if(stale!==null) throw Error('stale capture accepted');
          document.querySelector('#toggle-capture').click();
          await waitFor(async () => !(await api('bootstrap')).observation.observing);
          if((await api('bootstrap')).observation.lastFrame) throw Error('buffer retained after stop');
          replayed = true;
        }
        document.querySelector('#source-kind').value='window';
        selectedWindow=${JSON.stringify({ id: checkSource.id, name: checkSource.name })}; render(state);
        document.querySelector('#toggle-capture').click();
        await waitFor(async () => { const s=await api('bootstrap'); return s.observation.observing && s.observation.lastFrame; });
        const native=await api('bootstrap');
        if(!native.records.some(r=>r.kind==='frame' && r.source==='window' && r.payload.window==='Companion capture check')) throw Error('native capture not saved');
        render(await api('window:compact',true)); await pause(1300);
        if((await api('bootstrap')).observation.lastFrame===native.observation.lastFrame || !stream?.active) throw Error('overlay stopped the chosen window capture');
        render(await api('window:input',true)); render(await api('window:input',false));
        const passiveFrame=(await api('bootstrap')).observation.lastFrame; await pause(1300);
        if((await api('bootstrap')).observation.lastFrame===passiveFrame) throw Error('passive overlay stopped capture');
        render(await api('window:compact',false));
        document.querySelector('#toggle-capture').click();
        await waitFor(async () => !(await api('bootstrap')).observation.observing);
        document.querySelector('#source-kind').value='video'; render(state);
        const other = await api('world:create', {name:'격리 검증',game:'Stardew Valley',goal:'봄 농사'}); render(other);
        if(!document.querySelector('#guide-card').hidden || form.elements.demand.value) throw Error('world state leaked into new game');
        if(other.records.some(r=>r.kind==='frame')) throw Error('evidence leaked into new world');
        render(await api('world:select',firstId));
        if(world().state.inputs.demand!=='2') throw Error('fleet input not restored');
        render(await api('world:update',{status:'cancelled',step:0}));
        render(await api('world:update',{status:'proposed'}));
        setView('memory'); document.querySelector('#new-note').value='smokeOriginal'; document.querySelector('#note-form').requestSubmit();
        await waitFor(() => document.querySelector('#record-list').textContent.includes('smokeOriginal'));
        [...document.querySelectorAll('.record-card')].find(c=>c.textContent.includes('smokeOriginal')).querySelector('button').click();
        await waitFor(() => document.querySelector('#record-dialog').open);
        document.querySelector('#edit-note').value='smokeCorrected'; document.querySelector('#record-form').requestSubmit();
        await waitFor(() => !document.querySelector('#record-dialog').open && document.querySelector('#record-list').textContent.includes('smokeCorrected'));
        if((await api('record:search','smokeOriginal')).length) throw Error('edited memory retained in search');
        const seed=state.records.find(r=>r.kind==='frame' && r.source==='video' && r.payload.text); if(seed) showEvidence(seed);
        render(await api('world:select',genericId)); setView('play'); document.querySelector('#play-view').scrollIntoView(); window.scrollTo(0,0);
        return {title:document.title,stepCount:document.querySelectorAll('.step-button').length,sqlite:true,replayed,nativeWindowCaptured:true,secureStorageRoundtrip:true,worldIsolation:true,planLifecycle:true,fleetForm:true,memoryEdit:true,genericCompanion:true,dialogueVisibility:true,profile:true,compactWindow:true};
      })()`, true);
      const example=store.worlds().find(w=>w.state.scenario==='anno-hops');
      const seed=store.records(example.id,500).find(r=>r.kind==='frame' && r.payload.text) || store.records(example.id,500).find(r=>r.kind==='frame');
      const testAnswer=store.add(example.id,'answer','model',{question:'UI 검증용 · 어디를 봤어?',summary:'UI 검증용 · 이 기록에서 함께 확인해보자.',event_type:'help',next_action:'UI 검증용 · 다음 행동 하나',facts:[{text:'UI 검증용 · 원본 영역',evidence_id:seed.id}],annotations:[{evidence_id:seed.id,x:.699,y:.894,width:.123,height:.034,label:'UI 검증용 · 선택한 영역'}]});
      const newerAnswer=store.add(example.id,'answer','model',{summary:'UI 검증용 · 다른 답변',annotations:[{evidence_id:seed.id,x:.1,y:.1,width:.1,height:.1,label:'UI 검증용 · 다른 위치'}]});
      const visuals=await win.webContents.executeJavaScript(`(async()=>{
        render(await call('world:select',${JSON.stringify(example.id)}));
        const bubble=[...document.querySelectorAll('.answer-bubble')].find(b=>b.textContent.includes('다음 행동 하나'));
        if(!bubble || !bubble.querySelector(':scope > .answer-next') || !bubble.querySelector('.evidence-thumbnail')) throw Error('action or visual buried');
        bubble.querySelector('.evidence-thumbnail').click();
        if(!document.querySelector('#evidence-dialog').open || !document.querySelector('#evidence-title').textContent.includes('선택한 영역') || !document.querySelector('#evidence-caption').textContent.includes('기록 화면')) throw Error('wrong answer annotation or missing timestamp');
        const crop=document.querySelector('#evidence-crop-view img'); if(parseFloat(crop.style.width)<=100) throw Error('target was not enlarged');
        document.querySelector('#correct-evidence').click();
        if(document.querySelector('#evidence-dialog').open || !document.querySelector('#question').value.includes('잘못 짚었어') || focusedEvidenceId!==${JSON.stringify(seed.id)}) throw Error('correction lost its image');
        render(await call('world:update',{step:3})); document.querySelector('#case-tools').open=true;
        if(document.querySelector('#cargo-example').hidden || !document.querySelector('#cargo-example').textContent.includes('게임 UI 재현이 아니에요')) throw Error('concept example mislabeled');
        render(await call('world:select',${JSON.stringify(genericId)}));
        if(focusedEvidenceId || document.querySelector('#evidence-dialog').open || document.querySelector('#evidence-original').hasAttribute('src')) throw Error('image context leaked across worlds');
        return {inlineEvidence:true,expandedRegion:true,answerSpecificMarks:true,correctionContext:true,conceptLabels:true};
      })()`,true);
      Object.assign(result,visuals);
      for(const record of [testAnswer,newerAnswer]) store.remove(example.id,record.id);
      const oldSettings={...settings}, originalFetch=global.fetch;
      const otherFrame=store.frame(genericId,nativeImage.createFromBitmap(Buffer.from([255,255,255,255]),{width:1,height:1}).toJPEG(80),{source:'window',width:1,height:1});
      try {
        activeWorld=example.id; settings.analysisConsent=true; settings.model='smoke-model';
        fs.writeFileSync(path.join(directory,'key.enc'),safeStorage.encryptString('sk-or-smoke-fixture'));
        let releaseResponse;
        global.fetch=async(url,init)=>{
          if(url!=='https://openrouter.ai/api/v1/chat/completions') throw Error('unexpected smoke request');
          const request=JSON.parse(init.body), context=JSON.parse(request.messages[1].content[0].text);
          if(context.question.includes('기본 비교') ? context.evidence.length!==2 : context.evidence.length!==1 || context.evidence[0].id!==seed.id) throw Error('selected image or default comparison was not sent');
          if(context.question==='UI 검증용 · 오버레이 질문') await new Promise(resolve=>{releaseResponse=resolve;});
          return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({summary:'UI 검증용 · 지정 이미지 확인',should_speak:true,event_type:'help',event_key:'fixture',focus_busy:false,goal_related:true,facts:[],hypotheses:[],missing_information:[],suggestions:[],memory_proposals:[],annotations:[],next_action:''})}}]}));
        };
        const answer=await runAnalysis('UI 검증용 · 이 이미지',false,seed.id); store.remove(example.id,answer.id);
        const comparison=await runAnalysis('UI 검증용 · 기본 비교'); store.remove(example.id,comparison.id);
        let blocked=false; try{await runAnalysis('UI 검증용 · 다른 월드',false,otherFrame.id);}catch{blocked=true;} if(!blocked) throw Error('foreign world image accepted');
        result.selectedEvidence=true;
        result.defaultComparison=true;
        const waitWindow=async(predicate,label)=>{for(let i=0;i<200;i++){if(await predicate()) return; await new Promise(r=>setTimeout(r,25));} throw Error(`overlay ${label} timed out (input=${overlayInteractive}, companion=${win.isFocused()}, game=${captureCheck.isFocused()})`);};
        if(!shortcuts.chat || !shortcuts.visibility || !globalShortcut.isRegistered(shortcuts.chat) || !globalShortcut.isRegistered(shortcuts.visibility)) throw Error('overlay shortcuts unavailable');
        const fallback=registerShortcut([shortcuts.chat,'CommandOrControl+Shift+F7'],()=>{});
        if(fallback!=='CommandOrControl+Shift+F7') throw Error('shortcut conflict fallback failed');
        globalShortcut.unregister(fallback);
        const normalBounds=win.getNormalBounds();
        const gameDirectory=path.join(directory,'foreground-window'), readyFile=path.join(gameDirectory,'ready.txt');
        foregroundCheck=spawn(process.execPath,[path.join(__dirname,'../test/foreground-window.cjs'),gameDirectory],{windowsHide:true,stdio:'ignore'});
        await waitWindow(()=>fs.existsSync(readyFile),'separate game window');
        const gameNativeHandle=fs.readFileSync(readyFile,'utf8');
        if(!/^\d+$/.test(gameNativeHandle)) throw Error('invalid game window handle');
        if (!await activateForeground(BigInt(gameNativeHandle))) throw Error('native game foreground denied');
        rememberForeground();
        await waitWindow(()=>currentForeground() === previousForeground,'initial native game foreground');
        await setCompact(true);
        await waitWindow(async()=>currentForeground() === previousForeground && !win.isFocusable() && !overlayInteractive,'passive native game foreground');
        const cursorBeforeBuddy = {}; cursor(cursorBeforeBuddy);
        try {
          const empty = screen.dipToScreenPoint({ x: win.getBounds().x + 8, y: win.getBounds().y + 8 });
          moveCursor(empty.x, empty.y);
          await waitWindow(() => (nativeWindows.style(windowHandle(), -20) & 0x20) !== 0, 'empty space passes clicks to the game');
          if(!win.isAlwaysOnTop() || win.getOpacity()!==1 || win.isResizable() || win.isFocusable()) throw Error('companion native window flags missing');
          const face = await win.webContents.executeJavaScript('JSON.stringify((()=>{const r=document.querySelector("#buddy-button").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})())');
          const position = JSON.parse(face), target = screen.dipToScreenPoint({ x: Math.round(win.getBounds().x + position.x), y: Math.round(win.getBounds().y + position.y) });
          moveCursor(target.x, target.y);
          await waitWindow(() => (nativeWindows.style(windowHandle(), -20) & 0x20) === 0, 'avatar accepts mouse clicks');
          if(win.isFocusable() || currentForeground()!==previousForeground) throw Error('hovering the companion stole game focus');
          if(BigInt(ancestor(atPoint(target),2))!==windowHandle()) throw Error('companion is covered; no mouse input sent');
          click(2,0,0,0,0); click(4,0,0,0,0);
        } finally { moveCursor(cursorBeforeBuddy.x,cursorBeforeBuddy.y); }
        await waitWindow(async()=>win.isFocused() && await win.webContents.executeJavaScript('document.activeElement===document.querySelector("#question")'),'avatar composer focus');
        if((nativeWindows.style(windowHandle(), -20) & 0x20) !== 0) throw Error('input mode still passed mouse clicks through');
        await win.webContents.executeJavaScript('document.querySelector("#question").value="아직 안 보낸 질문"');
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await waitWindow(async()=>!overlayInteractive && currentForeground() === previousForeground,'Escape native game foreground');
        if(await win.webContents.executeJavaScript('document.querySelector("#question").value')!=='아직 안 보낸 질문') throw Error('Escape lost draft');
        await toggleChat();
        await waitWindow(()=>win.isFocused() && overlayInteractive,'question focus');
        await win.webContents.executeJavaScript(`document.querySelector('#question').value='UI 검증용 · 오버레이 질문'; focusedEvidenceId=${JSON.stringify(seed.id)};`);
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
        await waitWindow(async()=>releaseResponse && job && !overlayInteractive && currentForeground() === previousForeground,'send returns to native game while pending');
        await toggleChat(); await waitWindow(()=>overlayInteractive && win.isFocused(),'prepare next draft');
        await win.webContents.executeJavaScript('document.querySelector("#question").value="다음 질문 준비"');
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
        await waitWindow(async()=>!overlayInteractive && currentForeground() === previousForeground,'second Escape');
        releaseResponse(); await waitWindow(async()=>!job && await win.webContents.executeJavaScript('!asking'),'answer completion');
        if(currentForeground() !== previousForeground || win.isFocusable()) throw Error('answer stole native game foreground');
        if(await win.webContents.executeJavaScript('document.querySelector("#question").value')!=='다음 질문 준비') throw Error('answer overwrote next draft');
        const overlayAnswer=store.context(example.id).find(r=>r.kind==='answer' && r.payload.question==='UI 검증용 · 오버레이 질문');
        if(!overlayAnswer || !await win.webContents.executeJavaScript('document.querySelector("#messages").textContent.includes("지정 이미지 확인")')) throw Error('overlay answer not displayed');
        await win.webContents.executeJavaScript(`{
          const bubble=document.querySelector('#buddy-bubble'), summary=document.querySelector('#buddy-speech-text').getBoundingClientRect();
          if(bubble.hidden || !bubble.textContent.includes('지정 이미지 확인') || document.querySelector('#chat-form').offsetHeight || document.querySelector('#buddy-preview').hidden) throw Error('companion preview or evidence missing');
          if(summary.top<0 || summary.bottom>innerHeight) throw Error('companion answer hidden outside viewport');
        }`);
        await win.webContents.executeJavaScript('document.querySelector("#toast").hidden=true');
        fs.writeFileSync(path.join(__dirname,'../.local/overlay-preview.png'),(await win.webContents.capturePage()).toPNG());
        await toggleChat();
        focusChoiceCheck=new BrowserWindow({width:400,height:250,show:false,title:'Companion focus choice check',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        await focusChoiceCheck.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27">Other window choice check');
        focusChoiceCheck.show();
        const otherBuffer=focusChoiceCheck.getNativeWindowHandle(), otherWindow=otherBuffer.length===8?otherBuffer.readBigUInt64LE():BigInt(otherBuffer.readUInt32LE());
        if(!await activateForeground(otherWindow)) throw Error('other window foreground denied');
        await waitWindow(()=>!overlayInteractive && currentForeground()===otherWindow,'respect user choosing another window');
        if(!await activateForeground(BigInt(gameNativeHandle))) throw Error('game return before hide denied');
        await toggleOverlayVisibility(); if(win.isVisible() || currentForeground() !== previousForeground) throw Error('overlay hide failed');
        await toggleOverlayVisibility(); if(!win.isVisible() || overlayInteractive || currentForeground() !== previousForeground) throw Error('overlay show stole focus');
        const savedShortcut=shortcuts.chat; shortcuts.chat=null; await setOverlayInput(false);
        if(overlayInteractive || win.isFocusable()) throw Error('shortcut failure forced input mode');
        await win.webContents.executeJavaScript('document.querySelector("#buddy-button").click()',true);
        await waitWindow(()=>overlayInteractive && win.isFocusable(),'avatar access without question shortcut');
        await setOverlayInput(false);
        const savedVisibility = shortcuts.visibility; shortcuts.visibility = null;
        await win.webContents.executeJavaScript('call("window:action","minimize")',true);
        await waitWindow(()=>!compact && win.isMinimized(),'taskbar recovery without registered shortcuts');
        win.restore(); shortcuts.chat=savedShortcut; shortcuts.visibility=savedVisibility;
        await waitWindow(()=>!win.isMinimized(),'restore taskbar fallback');
        if(JSON.stringify(win.getNormalBounds())!==JSON.stringify(normalBounds) || win.isAlwaysOnTop() || !win.isFocusable() || win.getOpacity()!==1) throw Error('normal window was not restored');
        store.remove(example.id,overlayAnswer.id);
        await win.webContents.executeJavaScript('document.querySelector("#question").value=""; document.querySelector("#toast").hidden=true;');
        result.overlayFocus=true; result.overlaySendWhilePending=true; result.overlayCaptureContinuity=true; result.overlayShortcutFallback=true; result.overlayHide=true; result.overlayClickThrough=true; result.overlayAvatarClick=true;
        foregroundCheck.kill();
      } finally { global.fetch=originalFetch; settings=oldSettings; activeWorld=genericId; store.remove(genericId,otherFrame.id); fs.rmSync(path.join(directory,'key.enc'),{force:true}); }
      for (const r of uiFixtures) if (store.db.prepare('SELECT id FROM records WHERE id=? AND deleted_at IS NULL').get(r.id)) store.remove(genericId, r.id);
      await win.webContents.executeJavaScript('(async()=>{render(await call("bootstrap")); if(document.querySelector("#messages").textContent.includes("UI 검증용")) throw Error("fixture cleanup failed"); document.querySelector("#toast").hidden=true; await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()', true);
      fs.mkdirSync(path.join(__dirname, '../.local'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, '../.local/ui-preview.png'), (await win.webContents.capturePage()).toPNG());
      const evaluationFile=path.join(__dirname,'../.local/evaluation-after-learn.json');
      if(fs.existsSync(evaluationFile) && seed.source==='video') {
        const report=JSON.parse(fs.readFileSync(evaluationFile,'utf8')).reports[0];
        const answer=store.add(example.id,'answer','model',{...report.answer,question:`실제 모델 리플레이 평가 · ${report.question}`,facts:report.answer.facts.map(f=>({...f,evidence_id:seed.id})),annotations:report.answer.annotations.map(m=>({...m,evidence_id:seed.id}))});
        await win.webContents.executeJavaScript(`(async()=>{render(await call('world:select',${JSON.stringify(example.id)})); render(await call('world:update',{step:1})); document.querySelector('#case-tools').open=false; document.querySelector('#messages').scrollTop=document.querySelector('#messages').scrollHeight; document.querySelector('#toast').hidden=true; await Promise.all([...document.querySelectorAll('#play-view img')].filter(i=>i.src).map(i=>i.decode().catch(()=>{}))); await new Promise(r=>setTimeout(r,150));})()`,true);
        fs.writeFileSync(path.join(__dirname,'../.local/guide-preview.png'),(await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`(async()=>{openEvidence(state.records.find(r=>r.id===${JSON.stringify(seed.id)}),state.records.find(r=>r.id===${JSON.stringify(answer.id)}).payload.annotations[0] || state.records.find(r=>r.id===${JSON.stringify(seed.id)}).payload.annotations[1],state.records.find(r=>r.id===${JSON.stringify(answer.id)})); await Promise.all([...document.querySelectorAll('#evidence-dialog img')].map(i=>i.decode().catch(()=>{}))); await new Promise(r=>setTimeout(r,150));})()`,true);
        fs.writeFileSync(path.join(__dirname,'../.local/evidence-preview.png'),(await win.webContents.capturePage()).toPNG());
      }
      foregroundCheck?.kill(); console.log('SMOKE PASS', JSON.stringify(result)); app.exit(0);
    } catch (e) { foregroundCheck?.kill(); console.error('SMOKE FAIL', e.message); app.exit(1); }
    finally { foregroundCheck?.kill(); if (captureCheck && !captureCheck.isDestroyed()) captureCheck.close(); if (focusChoiceCheck && !focusChoiceCheck.isDestroyed()) focusChoiceCheck.close(); }
  }
}).catch(e => { console.error('앱 시작 실패:', e.message); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
