const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { text, PLAN_STATES, transitionPlan } = require('./core.cjs');
const { EXPERIENCE_TRANSITIONS, OUTCOMES, LIMITS, field, validateProposal, validateProposals, queryTerms, frameRefs, memoryForModel } = require('./learning.cjs');
const { withinBudget, CONTEXT_LIMITS } = require('./stream-context.cjs');

function openStore(directory) {
  fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'companion.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS worlds(id TEXT PRIMARY KEY, name TEXT NOT NULL, game TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, kind TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
    CREATE INDEX IF NOT EXISTS records_world ON records(world_id, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS record_search USING fts5(id UNINDEXED, world_id UNINDEXED, body);
    CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, model TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    PRAGMA user_version=1;`);
  function world(id) {
    const row = db.prepare('SELECT * FROM worlds WHERE id=?').get(id);
    if (!row) throw new Error('월드를 찾을 수 없어요.');
    return { ...row, state: JSON.parse(row.state) };
  }
  function records(id, limit = 100) {
    world(id);
    return db.prepare('SELECT * FROM records WHERE world_id=? AND deleted_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(id, limit).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  function context(id) {
    world(id);
    return db.prepare("SELECT * FROM records WHERE world_id=? AND deleted_at IS NULL AND (kind IN ('goal','plan','note') OR (kind='answer' AND (COALESCE(json_extract(payload,'$.automatic'),0)=0 OR json_extract(payload,'$.delivered')=1))) ORDER BY created_at DESC, rowid DESC LIMIT 100").all(id).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  function experiences(id, limit = 30) {
    world(id);
    return db.prepare("SELECT * FROM records WHERE world_id=? AND kind='experience' AND deleted_at IS NULL ORDER BY CASE WHEN json_extract(payload,'$.status') IN ('proposed','accepted','applied') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT ?").all(id, limit).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  function snapshotRecords(id) {
    const selected = new Map([...records(id), ...context(id), ...experiences(id)].map(r => [r.id, r]));
    for (const r of [...selected.values()]) for (const ref of r.payload.experience_ids || []) {
      if (selected.has(ref)) continue;
      const experience = db.prepare("SELECT * FROM records WHERE world_id=? AND id=? AND kind='experience' AND deleted_at IS NULL").get(id, ref);
      if (experience) selected.set(ref, { ...experience, payload: JSON.parse(experience.payload) });
    }
    for (const r of [...selected.values()]) for (const ref of frameRefs(r)) {
      if (selected.has(ref)) continue;
      const frame = db.prepare("SELECT * FROM records WHERE world_id=? AND id=? AND kind='frame' AND deleted_at IS NULL").get(id, ref);
      if (frame) selected.set(ref, { ...frame, payload: JSON.parse(frame.payload) });
    }
    return [...selected.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  function promptContext(id, question) {
    const recent = context(id);
    const selected = [...new Map([...search(id, question, true), ...experiences(id, 4), ...recent.filter(r => ['goal', 'plan', 'note'].includes(r.kind)).slice(0, 6)].map(r => [r.id, r])).values()].slice(0, 18);
    const unavailable = ref => { try { evidence(id, ref); return false; } catch { return true; } };
    const bounded = withinBudget(selected.map(r => memoryForModel(r, unavailable)), CONTEXT_LIMITS.memoryCharacters);
    return { recent, memories: bounded.items, omittedMemories: bounded.omitted };
  }
  function analysisContext(id, question, evidenceId = null, options = {}) {
    const result = promptContext(id, question);
    if (evidenceId) return { ...result, evidence: [evidence(id, evidenceId)] };
    const latest = db.prepare("SELECT id FROM records WHERE world_id=? AND kind='frame' AND deleted_at IS NULL AND COALESCE(json_extract(payload,'$.expired'),0)=0 ORDER BY created_at DESC,rowid DESC LIMIT 8").all(id).flatMap(r => { try { return [evidence(id, r.id)]; } catch { return []; } });
    // Resolve every recalled reference through this world's store, including old answer images.
    const recalled = [...new Set(result.memories.flatMap(frameRefs))].flatMap(ref => { try { return [evidence(id, ref)]; } catch { return []; } });
    if (options.recentEvidence?.length) {
      const current = options.recentEvidence.slice(-CONTEXT_LIMITS.recentFrames).map(f => evidence(id, f.id));
      const currentIds = new Set(current.map(f => f.id));
      const historical = recalled.filter(f => !currentIds.has(f.id)).slice(0, CONTEXT_LIMITS.evidenceFrames - current.length);
      return { ...result, evidence: [...current.map((f, i) => ({ ...f, context_role: i === current.length - 1 ? 'current' : 'recent' })), ...historical.map(f => ({ ...f, context_role: 'recalled' }))] };
    }
    const prior = recalled.find(r => r.id !== latest[0]?.id);
    return { ...result, evidence: latest.length ? [{ ...latest[0], context_role: 'record' }, ...(prior ? [{ ...prior, context_role: 'recalled' }] : latest.slice(1, 2))] : [] };
  }
  function add(id, kind, source, payload) {
    world(id);
    const row = { id: randomUUID(), world_id: id, kind, source, payload, created_at: new Date().toISOString() };
    db.exec('SAVEPOINT add_record');
    try {
      db.prepare('INSERT INTO records(id,world_id,kind,source,payload,created_at) VALUES(?,?,?,?,?,?)').run(row.id, id, kind, source, JSON.stringify(payload), row.created_at);
      db.prepare('INSERT INTO record_search VALUES(?,?,?)').run(row.id, id, JSON.stringify(payload));
      db.exec('RELEASE add_record');
    } catch (e) { db.exec('ROLLBACK TO add_record; RELEASE add_record'); throw e; }
    return row;
  }
  function record(id, recordId) {
    world(id);
    const row = db.prepare('SELECT * FROM records WHERE world_id=? AND id=? AND deleted_at IS NULL').get(id, recordId);
    if (!row) throw new Error('이 월드의 기록을 찾을 수 없어요.');
    return { ...row, payload: JSON.parse(row.payload) };
  }
  function invalidateLinked(id, recordId) {
    const links = new Map();
    for (const answer of records(id, -1).filter(r => ['answer', 'experience'].includes(r.kind))) {
      for (const ref of [...(answer.payload.evidence || []), ...(answer.payload.memory_refs || [])]) {
        if (!links.has(ref)) links.set(ref, []);
        links.get(ref).push(answer.id);
      }
    }
    const queue = [recordId], seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) for (const answerId of links.get(queue[i]) || []) {
      if (seen.has(answerId)) continue;
      seen.add(answerId); queue.push(answerId);
      db.prepare('UPDATE records SET deleted_at=? WHERE id=?').run(new Date().toISOString(), answerId);
      db.prepare('DELETE FROM record_search WHERE id=?').run(answerId);
    }
  }
  function amend(id, recordId, payload, invalidate = false) {
    record(id, recordId);
    db.exec('SAVEPOINT amend_record');
    try {
      db.prepare('UPDATE records SET payload=? WHERE id=? AND world_id=?').run(JSON.stringify(payload), recordId, id);
      db.prepare('DELETE FROM record_search WHERE id=? AND world_id=?').run(recordId, id);
      db.prepare('INSERT INTO record_search VALUES(?,?,?)').run(recordId, id, JSON.stringify(payload));
      if (invalidate) invalidateLinked(id, recordId);
      db.exec('RELEASE amend_record');
    } catch (e) { db.exec('ROLLBACK TO amend_record; RELEASE amend_record'); throw e; }
    return record(id, recordId);
  }
  function create(name, game, goal, scenario = null) {
    name = text(name, 100); game = text(game, 100); goal = text(goal, 1000);
    if (!name || !game || (scenario !== null && (scenario !== 'anno-hops' || game !== 'anno1800'))) throw new Error('플레이 이름과 게임을 확인해주세요.');
    const id = randomUUID(), now = new Date().toISOString();
    db.prepare('INSERT INTO worlds VALUES(?,?,?,?,?,1,?,?)').run(id, name, game, goal, JSON.stringify({ step: 0, status: 'proposed', inputs: {}, scenario }), now, now);
    if (goal) add(id, 'goal', 'user', { text: goal });
    return world(id);
  }
  function update(id, changes) {
    const previous = world(id), state = { ...previous.state };
    let goal = previous.goal;
    if (changes.goal !== undefined) goal = text(changes.goal, 1000);
    if (changes.step !== undefined) {
      if (!Number.isInteger(changes.step) || changes.step < 0 || changes.step > 5) throw new Error('안내 단계를 확인해주세요.');
      state.step = changes.step;
    }
    if (changes.status !== undefined) state.status = transitionPlan(state.status, changes.status);
    if (changes.inputs !== undefined) {
      if (!changes.inputs || typeof changes.inputs !== 'object' || Array.isArray(changes.inputs)) throw new Error('계산 입력 형식을 확인해주세요.');
      state.inputs = Object.fromEntries(['demand', 'cycle', 'slots', 'perSlot', 'production'].map(k => [k, text(String(changes.inputs[k] ?? ''), 32)]));
    }
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE worlds SET goal=?,state=?,revision=revision+1,updated_at=? WHERE id=?').run(goal, JSON.stringify(state), new Date().toISOString(), id);
      if (goal !== previous.goal) add(id, 'goal', 'user', { text: goal, previous: previous.goal });
      if (state.status !== previous.state.status) add(id, 'plan', 'user', { text: PLAN_STATES[state.status], status: state.status, previous: previous.state.status });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return world(id);
  }
  function frame(id, data, metadata) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='frame' AND deleted_at IS NULL AND COALESCE(json_extract(payload,'$.expired'),0)=0").get().n;
    if (count >= 300) throw new Error('근거 이미지 보관 한도(300장)에 도달했어요. 기억에서 불필요한 화면을 삭제해주세요.');
    const filename = `${randomUUID()}.jpg`;
    fs.writeFileSync(path.join(directory, 'evidence', filename), data);
    try { return add(id, 'frame', metadata.source, { ...metadata, filename }); }
    catch (e) { fs.unlinkSync(path.join(directory, 'evidence', filename)); throw e; }
  }
  function evidence(id, recordId) {
    const row = record(id, recordId);
    if (row.kind !== 'frame' || row.payload.expired) throw new Error('이미지 근거가 없거나 보관 기간이 지났어요.');
    const file = path.join(directory, 'evidence', path.basename(row.payload.filename));
    if (!fs.existsSync(file)) throw new Error('원본 이미지가 삭제됐어요.');
    return { ...row, file };
  }
  function remove(id, recordId) {
    const row = record(id, recordId);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE records SET deleted_at=? WHERE id=? AND world_id=?').run(new Date().toISOString(), recordId, id);
      db.prepare('DELETE FROM record_search WHERE id=? AND world_id=?').run(recordId, id);
      // Linked answers can contain the deleted fact or image: remove them from retrieval too.
      invalidateLinked(id, recordId);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (row.kind === 'frame') fs.rmSync(path.join(directory, 'evidence', path.basename(row.payload.filename)), { force: true });
  }
  function search(id, query, forPrompt = false) {
    world(id);
    const words = queryTerms(text(query, 1000));
    if (!words.length) return [];
    const match = words.map(w => `"${w.replaceAll('"', '""')}"*`).join(' OR ');
    const visible = forPrompt ? "AND r.kind IN ('goal','plan','note','answer','experience') AND (r.kind!='answer' OR COALESCE(json_extract(r.payload,'$.automatic'),0)=0 OR json_extract(r.payload,'$.delivered')=1)" : '';
    return db.prepare(`SELECT r.id FROM record_search JOIN records r ON r.id=record_search.id WHERE r.world_id=? AND r.deleted_at IS NULL AND record_search MATCH ? ${visible} ORDER BY rank LIMIT 8`).all(id, match).map(row => record(id, row.id));
  }
  function expireFrame(id, recordId) {
    const row = record(id, recordId);
    if (row.kind !== 'frame' || row.payload.expired) return;
    db.exec('SAVEPOINT expire_frame');
    try {
      amend(id, recordId, { ...row.payload, expired: true, expired_at: new Date().toISOString() });
      for (const r of experiences(id, -1)) if (frameRefs(r).includes(recordId)) amend(id, r.id, { ...r.payload, needs_review: true, revision: r.payload.revision + 1 });
      db.exec('RELEASE expire_frame');
    } catch (e) { db.exec('ROLLBACK TO expire_frame; RELEASE expire_frame'); throw e; }
    fs.rmSync(path.join(directory, 'evidence', path.basename(row.payload.filename)), { force: true });
  }
  function prune() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const row of db.prepare("SELECT * FROM records WHERE kind='frame' AND deleted_at IS NULL AND COALESCE(json_extract(payload,'$.expired'),0)=0").all()) {
      if (Date.parse(row.created_at) < cutoff) expireFrame(row.world_id, row.id);
    }
  }
  function createExperience(id, input, originAnswer = null) {
    const refs = input.evidence_ids || [];
    for (const ref of refs) evidence(id, ref);
    const proposal = validateProposal({ ...input, evidence_ids: refs }, new Set(refs));
    if (originAnswer) {
      const origin = record(id, originAnswer);
      if (origin.kind !== 'answer') throw new Error('제안의 원래 답변을 확인할 수 없어요.');
    }
    const { evidence_ids, ...content } = proposal;
    return add(id, 'experience', originAnswer ? 'model' : 'user', { ...content, status: 'proposed', outcome: 'inconclusive', result: '', note: '', revision: 1, needs_review: false, before_evidence: evidence_ids, after_evidence: [], evidence: evidence_ids, memory_refs: originAnswer ? [originAnswer] : [], origin_answer_id: originAnswer, history: [{ status: 'proposed', source: originAnswer ? 'model' : 'user', at: new Date().toISOString() }] });
  }
  function saveAnswer(id, source, payload) {
    db.exec('SAVEPOINT save_answer');
    try {
      const answer = add(id, 'answer', source, payload);
      const proposals = payload.automatic && !payload.delivered ? [] : payload.learning_proposals || [];
      const candidates = validateProposals(proposals, (payload.evidence || []).map(ref => evidence(id, ref)));
      const linked = candidates.map(p => experiences(id, -1).find(r => ['proposed', 'accepted', 'applied'].includes(r.payload.status) && r.payload.action === p.action && r.payload.check === p.check && r.payload.conditions === p.conditions) || createExperience(id, p, answer.id));
      const saved = amend(id, answer.id, { ...payload, experience_ids: linked.map(r => r.id) });
      db.exec('RELEASE save_answer'); return saved;
    } catch (e) { db.exec('ROLLBACK TO save_answer; RELEASE save_answer'); throw e; }
  }
  function updateExperience(id, recordId, changes) {
    const row = record(id, recordId), p = row.payload;
    if (row.kind !== 'experience' || !changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('수정할 경험을 확인해주세요.');
    const allowed = [...Object.keys(LIMITS), 'status', 'outcome', 'expected_revision', 'after_evidence'];
    if (Object.keys(changes).some(k => !allowed.includes(k))) throw new Error('경험 수정 항목을 확인해주세요.');
    if (changes.expected_revision !== p.revision) throw new Error('경험이 바뀌었어요. 다시 열어서 수정해주세요.');
    const next = { ...p };
    for (const k of Object.keys(LIMITS)) if (changes[k] !== undefined) next[k] = field(changes[k], k, ['title', 'action', 'check'].includes(k));
    const status = changes.status ?? p.status;
    if (status !== p.status && !EXPERIENCE_TRANSITIONS[p.status]?.includes(status)) throw new Error('제안 수락·실제 적용·결과 기록을 순서대로 확인해주세요.');
    if (changes.outcome !== undefined) {
      if (!Object.hasOwn(OUTCOMES, changes.outcome)) throw new Error('관찰한 결과를 선택해주세요.');
      next.outcome = changes.outcome;
    }
    if (status !== 'completed' && (next.outcome !== 'inconclusive' || next.result)) throw new Error('적용 후 결과 남기기에서 관찰 내용을 기록해주세요.');
    if (status === 'completed' && !next.result) throw new Error('결과와 아직 확인하지 못한 내용을 적어주세요.');
    if (changes.after_evidence !== undefined) {
      if (status !== 'completed' || !Array.isArray(changes.after_evidence) || changes.after_evidence.length > 4) throw new Error('결과 화면을 확인해주세요.');
      for (const ref of changes.after_evidence) evidence(id, ref);
      next.after_evidence = [...new Set(changes.after_evidence)];
    }
    next.status = status; next.revision++; next.updated_at = new Date().toISOString();
    if (status === 'completed') next.result_source = 'user';
    if (['applied', 'completed'].includes(p.status) && ['hypothesis', 'action', 'check', 'conditions'].some(k => next[k] !== p[k])) next.needs_review = true;
    next.evidence = [...new Set([...next.before_evidence, ...next.after_evidence])];
    next.history = [...p.history, { status, source: 'user', at: next.updated_at, outcome: next.outcome }].slice(-20);
    db.exec('SAVEPOINT update_experience');
    try {
      const corrected = ['title', 'hypothesis', 'action', 'check', 'conditions'].some(k => next[k] !== p[k]) || (p.status === 'completed' && (next.result !== p.result || next.outcome !== p.outcome));
      const saved = amend(id, recordId, next, corrected);
      db.prepare('UPDATE worlds SET revision=revision+1,updated_at=? WHERE id=?').run(next.updated_at, id);
      db.exec('RELEASE update_experience'); return saved;
    } catch (e) { db.exec('ROLLBACK TO update_experience; RELEASE update_experience'); throw e; }
  }
  return { db, world, records, context, snapshotRecords, promptContext, analysisContext, experiences, createExperience, updateExperience, saveAnswer, record, amend, add, create, update, frame, evidence, remove, search, prune,
    reserveUsage: (model, payload) => { const id = randomUUID(); db.prepare('INSERT INTO usage VALUES(?,?,?,?)').run(id, model, new Date().toISOString(), JSON.stringify(payload)); return id; },
    updateUsage: (id, payload) => db.prepare('UPDATE usage SET payload=? WHERE id=?').run(JSON.stringify(payload), id),
    usageSince: start => db.prepare('SELECT * FROM usage WHERE created_at>=?').all(start).map(r => ({ ...r, payload: JSON.parse(r.payload) })),
    worlds: () => db.prepare('SELECT id FROM worlds ORDER BY created_at').all().map(row => world(row.id)),
    close: () => db.close() };
}
module.exports = { openStore };
