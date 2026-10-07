const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { text, PLAN_STATES, transitionPlan } = require('./core.cjs');

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
    for (const answer of records(id, -1).filter(r => r.kind === 'answer')) {
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
    const count = db.prepare("SELECT COUNT(*) AS n FROM records WHERE kind='frame' AND deleted_at IS NULL").get().n;
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
  function search(id, query) {
    world(id);
    const words = text(query, 1000).split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return [];
    // ponytail: FTS matches words, Korean morphological search can follow measured misses.
    const match = words.map(w => `"${w.replaceAll('"', '""')}"`).join(' OR ');
    return db.prepare('SELECT id FROM record_search WHERE world_id=? AND record_search MATCH ? ORDER BY rank LIMIT 8').all(id, match).map(row => record(id, row.id));
  }
  function prune() {
    const cutoff = Date.now() - 30 * 86400000;
    for (const row of db.prepare("SELECT * FROM records WHERE kind='frame' AND deleted_at IS NULL").all()) {
      if (Date.parse(row.created_at) < cutoff) remove(row.world_id, row.id);
    }
  }
  return { db, world, records, context, record, amend, add, create, update, frame, evidence, remove, search, prune,
    reserveUsage: (model, payload) => { const id = randomUUID(); db.prepare('INSERT INTO usage VALUES(?,?,?,?)').run(id, model, new Date().toISOString(), JSON.stringify(payload)); return id; },
    updateUsage: (id, payload) => db.prepare('UPDATE usage SET payload=? WHERE id=?').run(JSON.stringify(payload), id),
    usageSince: start => db.prepare('SELECT * FROM usage WHERE created_at>=?').all(start).map(r => ({ ...r, payload: JSON.parse(r.payload) })),
    worlds: () => db.prepare('SELECT id FROM worlds ORDER BY created_at').all().map(row => world(row.id)),
    close: () => db.close() };
}
module.exports = { openStore };
