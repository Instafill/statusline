'use strict';
// Best-effort masking of credential-looking substrings before they enter
// session state or a classification digest. Not exhaustive — a safety net.

const REPLACERS = [
  // Provider-prefixed tokens: replace the whole token.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, '***'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '***'], // JWT
  // key=value / key: value assignments: keep the key, mask the value.
  [/((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\s*[=:]\s*)(["']?)[^\s"'&;|]{6,}\2/gi, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1***'],
  // Credentials embedded in URLs: https://user:pass@host
  [/(\/\/[^\s/:@]+:)[^\s@]+(@)/g, '$1***$2'],
];

function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, sub] of REPLACERS) out = out.replace(re, sub);
  return out;
}

module.exports = { maskSecrets };
