const DEFAULT_MAX_CHARS = 80_000;
const DEFAULT_SUMMARY_CHARS = 12_000;
const DEFAULT_ITEM_CHARS = 20_000;

export function compactContext({
  thread = {},
  messages = [],
  maxChars = DEFAULT_MAX_CHARS,
  summaryMaxChars = DEFAULT_SUMMARY_CHARS,
  itemMaxChars = DEFAULT_ITEM_CHARS,
  minRecent = 12
} = {}) {
  const normalized = messages
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .map((item) => {
      const originalContent = String(item.content || "");
      return {
        ...item,
        originalLength: originalContent.length,
        content: clipMessage(originalContent, itemMaxChars)
      };
    })
    .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
  const kept = [];
  let chars = 0;
  let truncatedMessages = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const item = normalized[index];
    if (item.originalLength > item.content.length) truncatedMessages += 1;
    const cost = item.content.length + 64;
    if (kept.length >= minRecent && chars + cost > maxChars) break;
    kept.push(item);
    chars += cost;
  }
  kept.reverse();
  const firstKeptSeq = kept.length ? Number(kept[0].seq || 0) : Number.MAX_SAFE_INTEGER;
  const omitted = normalized.filter((item) => Number(item.seq || 0) < firstKeptSeq);
  let summary = String(thread.summary || "");
  let summarySeq = Number(thread.summarySeq || 0);
  if (omitted.length) {
    const additions = omitted.map((item) => {
      const role = item.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${clipMessage(item.content, 700)}`;
    }).join("\n");
    summary = clipSummary([summary, additions].filter(Boolean).join("\n"), summaryMaxChars);
    summarySeq = Math.max(summarySeq, ...omitted.map((item) => Number(item.seq || 0)));
  }
  const inputChars = normalized.reduce((total, item) => total + item.content.length, 0);
  return {
    history: kept,
    summary,
    summarySeq,
    stats: {
      inputMessages: normalized.length,
      keptMessages: kept.length,
      omittedMessages: omitted.length,
      inputChars,
      outputChars: chars + summary.length,
      estimatedTokens: Math.ceil((chars + summary.length) / 4),
      truncatedMessages
    }
  };
}

function clipMessage(value, limit) {
  if (value.length <= limit) return value;
  const half = Math.max(1, Math.floor((limit - 64) / 2));
  return `${value.slice(0, half)}\n[... content compacted ...]\n${value.slice(-half)}`;
}

function clipSummary(value, limit) {
  if (value.length <= limit) return value;
  return `[Earlier summary compacted]\n${value.slice(-(limit - 30))}`;
}
