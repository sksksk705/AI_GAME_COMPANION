const assert = require('node:assert/strict');
const { overlayBounds, hitRegions, hitsBuddy, canCheckIn, checkInText } = require('../src/buddy.cjs');
const { proactiveDecision } = require('../src/core.cjs');

module.exports = function checkBuddy() {
  // Growing upward preserves the companion's screen position, including negative-coordinate monitors.
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const mini = { x: -440, y: 720, width: 410, height: 280 };
  const expanded = overlayBounds(mini, area, true);
  assert.equal(expanded.y + expanded.height, mini.y + mini.height);
  assert.deepEqual(overlayBounds(expanded, area, false), mini);
  assert.deepEqual(overlayBounds({ x: 9000, y: 9000, width: 410, height: 280 }, { x: 0, y: 0, width: 360, height: 500 }, true), { x: 0, y: 0, width: 360, height: 500 });
  const rects = hitRegions([{ x: 310, y: 155, width: 85, height: 100 }, { x: 20, y: 40, width: 270, height: 100 }]);
  assert.equal(hitsBuddy({ x: mini.x + 350, y: mini.y + 180 }, mini, rects), true);
  assert.equal(hitsBuddy({ x: mini.x + 50, y: mini.y + 60 }, mini, rects), true);
  assert.equal(hitsBuddy({ x: mini.x + 300, y: mini.y + 20 }, mini, rects), false);
  assert.equal(hitsBuddy({ x: mini.x + 410, y: mini.y + 180 }, mini, rects), false);
  for (const input of [null, Array(9).fill({}), [{ x: -1, y: 0, width: 1, height: 1 }], [{ x: 0, y: 0, width: Infinity, height: 1 }]]) assert.throws(() => hitRegions(input));

  const now = Date.now(), candidate = { visible: true, interactive: false, mode: 'together', enabled: true, observing: true, source: 'window', blocked: false, busy: false, capturedAt: new Date(now - 1000).toISOString(), sessionStarted: now - 300000, lastInteraction: now - 300000, lastSpeech: now - 300000, recentSpeech: [] };
  assert.equal(canCheckIn(candidate, now), true);
  for (const patch of [{ mode: 'quiet' }, { mode: 'watch' }, { enabled: false }, { visible: false }, { interactive: true }, { observing: false }, { source: 'video' }, { blocked: true }, { busy: true }, { capturedAt: undefined }, { capturedAt: new Date(now - 15000).toISOString() }, { capturedAt: new Date(now + 1).toISOString() }, { sessionStarted: now - 239999 }, { lastInteraction: now - 239999 }, { lastSpeech: now - 239999 }, { recentSpeech: [now - 300000, now - 400000, now - 500000] }]) {
    assert.equal(canCheckIn({ ...candidate, ...patch }, now), false, JSON.stringify(patch));
  }
  assert.equal(canCheckIn({ ...candidate, recentSpeech: [now - 600000, now - 400000, now - 500000] }, now), true);
  assert.equal(canCheckIn({ ...candidate, count: 3 }, now), false, 'do not loop the same greetings indefinitely');
  const answer = { should_speak: true, event_type: 'reaction', event_key: 'fixture-event', focus_busy: false, facts: [{ evidence_id: 'fixture-frame' }] };
  const evidence = [{ id: 'fixture-frame', source: 'window', payload: { capturedAt: new Date(now - 1000).toISOString() } }];
  const presence = time => ({ kind: 'answer', created_at: new Date(time).toISOString(), payload: { automatic: true, delivered: true } });
  assert.equal(proactiveDecision(answer, { mode: 'together', sampleStable: true, evidence, records: [presence(now - 30000)], now }), 'cooldown');
  assert.equal(proactiveDecision(answer, { mode: 'together', sampleStable: true, evidence, records: [300000, 400000, 500000].map(age => presence(now - age)), now }), 'frequency-limit', 'AI and local greetings share the same speech budget');
  assert.match(checkInText({ tone: 'polite', style: 'calm' }, 0), /요/);
  assert.equal(checkInText({ tone: 'casual', style: 'playful' }, 3), checkInText({ tone: 'casual', style: 'playful' }, 0));
  console.log('PASS: companion geometry, visible click targets, local check-in consent/mode/session/freshness/idle/quota gates.');
};
