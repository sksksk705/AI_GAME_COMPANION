const { randomUUID } = require('node:crypto');

function requestSession({ store, model, type, used, limit, signal, isValid = () => true, onExhausted = () => {} }) {
  const sessionId = randomUUID();
  return async function run(stage, request) {
    signal?.throwIfAborted();
    if (used() >= limit()) { onExhausted(); throw new Error('오늘 앱 요청 한도에 도달했어요.'); }
    const metadata = { type, stage, sessionId };
    const id = store.reserveUsage(model, { ...metadata, status: 'sent' });
    try {
      const result = await request();
      store.updateUsage(id, { ...metadata, status: !signal?.aborted && isValid() ? 'completed' : 'discarded', usage: result.usage, providerId: result.providerId, model: result.model || model, timing: result.timing, inputStats: result.inputStats });
      return result;
    } catch (error) {
      store.updateUsage(id, { ...metadata, status: 'unknown' });
      throw error; // No automatic retry, including a failed generation after a successful assessment.
    }
  };
}
module.exports = { requestSession };
