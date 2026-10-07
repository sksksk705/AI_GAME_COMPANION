// Desktop geometry for the companion icon and speech bubble.
function overlayBounds(bounds, area, interactive) {
  const width = Math.min(410, area.width), height = Math.min(interactive ? 640 : 280, area.height);
  const bottom = bounds.y + bounds.height;
  return { width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bottom - height, area.y + area.height - height)) };
}
function hitRegions(input) {
  if (!Array.isArray(input) || input.length > 8) throw new Error('동료의 클릭 영역을 확인해주세요.');
  return input.map(rect => {
    if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0 || rect.x + rect.width > 2000 || rect.y + rect.height > 2000) throw new Error('동료의 클릭 영역을 확인해주세요.');
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
function hitsBuddy(point, bounds, regions) {
  const x = point.x - bounds.x, y = point.y - bounds.y;
  return x >= 0 && y >= 0 && x < bounds.width && y < bounds.height && regions.some(r => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
}
module.exports = { overlayBounds, hitRegions, hitsBuddy };
