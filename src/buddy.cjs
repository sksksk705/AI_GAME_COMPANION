// Desktop geometry and local presence policy. These messages never claim to read game state.
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
function canCheckIn({ visible, interactive, mode, enabled, observing, source, blocked, busy, capturedAt, sessionStarted, lastInteraction, lastSpeech, recentSpeech, count = 0 }, now = Date.now()) {
  const age = now - Date.parse(capturedAt);
  return visible && !interactive && mode === 'together' && enabled && observing && source === 'window' && !blocked && !busy && count < 3
    && age >= 0 && age < 15000 && now - sessionStarted >= 240000 && now - lastInteraction >= 240000
    && now - lastSpeech >= 240000 && recentSpeech.filter(time => now - time < 600000).length < 3;
}
function checkInText(profile, index) {
  const casual = {
    calm: ['천천히 해도 괜찮아. 궁금한 곳이 생기면 같이 짚어보자.', '난 여기 있을게. 지금 하던 것부터 편하게 이어가자.', '막히는 부분이 생기면 불러줘. 한 번에 하나씩 같이 생각해보자.'],
    playful: ['오늘도 옆자리 지키는 중! 궁금한 게 생기면 불러줘.', '혼자 고민하지 않아도 돼. 막히면 같이 작전을 짜보자.', '우리 속도로 가자. 필요하면 화면을 같이 짚어볼게.'],
    thoughtful: ['궁금한 부분이 생기면 작은 시도 하나부터 같이 정해보자.', '우리 판단이 맞았는지, 나중에 결과도 같이 돌아보자.', '급하게 결론 내리지 않아도 괜찮아. 필요할 때 같이 생각해보자.']
  };
  const polite = ['천천히 하셔도 괜찮아요. 궁금한 곳이 생기면 같이 짚어봐요.', '저는 여기 있을게요. 필요할 때 편하게 불러주세요.', '막히는 부분이 생기면 한 번에 하나씩 같이 생각해봐요.'];
  const messages = profile.tone === 'polite' ? polite : casual[profile.style] || casual.calm;
  return messages[index % messages.length];
}
module.exports = { overlayBounds, hitRegions, hitsBuddy, canCheckIn, checkInText };
