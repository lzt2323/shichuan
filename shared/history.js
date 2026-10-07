// Shared by the three clients. Transport snapshots are bounded; deltas never
// discard the older pages a person has explicitly opened.
export function mergeState(previous = {}, next = {}, { maxMessages = 500 } = {}) {
  if (next.mode !== 'delta') return { ...next, messages: (next.messages || []).slice(-maxMessages) };
  const messages = new Map((previous.messages || []).map(message => [message.id, message]));
  for (const message of next.messages || []) messages.set(message.id, message);
  const all = [...messages.values()].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  const kept = all.slice(-maxMessages);
  return { ...previous, ...next, messages: kept, history: { ...previous.history,
    ...(next.history ? { latest: next.history.latest, total: next.history.total } : {}),
    ...(all.length > kept.length ? { before: String(kept[0].sequence), hasMore: true } : {}),
  } };
}

export function prependHistory(previous = {}, page = {}, { maxMessages = 500 } = {}) {
  const messages = new Map((page.messages || []).map(message => [message.id, message]));
  for (const message of previous.messages || []) messages.set(message.id, message);
  const all = [...messages.values()].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  // Keep the page being read when loading backwards, rather than immediately
  // dropping it because a newer page already fills the client budget.
  return { ...previous, messages: all.slice(0, maxMessages), history: { ...page.history } };
}
