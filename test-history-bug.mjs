function scoreConversationEntry(role, content, index, total) {
  let score = Math.round(((index + 1) / Math.max(1, total)) * 40);
  if (role === 'user') score += 12;
  return score;
}

const history = [
  { role: 'user', content: 'Turn 1, quite a bit of text ' + 'a'.repeat(500) },
  { role: 'assistant', content: 'Reply 1 ' + 'b'.repeat(500) },
  { role: 'user', content: 'Turn 2 ' + 'c'.repeat(500) },
  { role: 'assistant', content: 'Reply 2 ' + 'd'.repeat(500) },
  { role: 'user', content: 'Turn 3' },
];

let bestStart = history.length;
let bestScore = Number.NEGATIVE_INFINITY;
let found = false;
for (let start = history.length - 1; start >= 0; start -= 1) {
  const suffix = history.slice(start);
  const chars = suffix.reduce((sum, entry) => sum + entry.content.length, 0);
  if (chars > 12000) continue;
  found = true;
  const score = suffix.reduce((sum, entry, offset) => {
    return sum + scoreConversationEntry(entry.role, entry.content, start + offset, history.length);
  }, 0) - Math.round(chars / 64);
  console.log(`Start ${start}: chars=${chars}, score=${score}`);
  if (score >= bestScore) {
    bestScore = score;
    bestStart = start;
  }
}
console.log('Best Start:', bestStart);
