const { conversation } = require('./core.cjs');

// Character budgets are predictable local bounds, not estimates of provider tokens.
const CONTEXT_LIMITS = Object.freeze({ memoryCharacters: 12000, dialogueCharacters: 6000, recentFrames: 3, evidenceFrames: 4 });

function withinBudget(items, characters, newestFirst = false) {
  let used = 0;
  const selected = [];
  for (const item of newestFirst ? [...items].reverse() : items) {
    const size = JSON.stringify(item).length;
    // Keep whole records: truncating a result can remove its uncertainty or correction.
    if (used + size > characters) continue;
    selected.push(item); used += size;
  }
  return { items: newestFirst ? selected.reverse() : selected, characters: used, omitted: items.length - selected.length };
}

function boundedContext(memories = [], recent = []) {
  const memory = withinBudget(memories, CONTEXT_LIMITS.memoryCharacters);
  const dialogue = withinBudget(conversation(recent), CONTEXT_LIMITS.dialogueCharacters, true);
  return { memories: memory.items, conversation: dialogue.items, budget: {
    memory_characters: memory.characters, dialogue_characters: dialogue.characters,
    omitted_memories: memory.omitted, omitted_dialogue_turns: dialogue.omitted
  } };
}

function recentFrames(frames, now = Date.now()) {
  const latest = frames.at(-1), time = Date.parse(latest?.capturedAt);
  if (!latest || latest.source !== 'window' || !(now - time >= 0 && now - time < 10000)) return [];
  const selected = [latest];
  for (let i = frames.length - 2; i >= 0 && selected.length < CONTEXT_LIMITS.recentFrames; i--) {
    const f = frames[i], age = time - Date.parse(f.capturedAt);
    if (!(age >= 0 && age <= 30000) || f.source !== latest.source || f.worldId !== latest.worldId || !f.sessionId || f.sessionId !== latest.sessionId || f.continuity !== latest.continuity || f.window !== latest.window || f.size.width !== latest.size.width || f.size.height !== latest.size.height) continue;
    if (Date.parse(selected.at(-1).capturedAt) - Date.parse(f.capturedAt) < 10000 || selected.some(s => s.bytes.equals(f.bytes))) continue;
    selected.push(f);
  }
  return selected.reverse();
}

module.exports = { CONTEXT_LIMITS, withinBudget, boundedContext, recentFrames };
