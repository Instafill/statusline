'use strict';
// Best-effort extraction of assistant message text from a Claude Code session
// transcript (JSONL). The transcript format is an internal implementation
// detail of Claude Code, so this module is deliberately defensive: any
// failure returns [] and classification proceeds without excerpts.
const fs = require('fs');

const TAIL_BYTES = 256 * 1024;

function extractText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function readAssistantExcerpts(transcriptPath, { maxExcerpts = 5, maxExcerptChars = 800 } = {}) {
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(transcriptPath, 'r');
    let raw;
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = raw.split('\n');
    if (start > 0) lines.shift(); // first line may be a partial record

    const excerpts = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch (e) {
        continue;
      }
      if (!obj || obj.isSidechain === true) continue;
      const isAssistant =
        obj.type === 'assistant' ||
        obj.role === 'assistant' ||
        (obj.message && obj.message.role === 'assistant');
      if (!isAssistant) continue;
      const text = extractText(obj.message || obj);
      if (!text || !text.trim()) continue;
      excerpts.push({
        at: typeof obj.timestamp === 'string' ? obj.timestamp : null,
        text: text.slice(0, maxExcerptChars),
        source: 'transcript_tail',
      });
    }
    return excerpts.slice(-maxExcerpts);
  } catch (e) {
    return [];
  }
}

module.exports = { readAssistantExcerpts };
