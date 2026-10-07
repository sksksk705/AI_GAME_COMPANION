const assert = require('node:assert/strict');
const { overlayBounds, hitRegions, hitsBuddy } = require('../src/buddy.cjs');

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

  console.log('PASS: companion geometry and visible click targets.');
};
