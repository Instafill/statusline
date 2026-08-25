'use strict';
// Technology-name normalization. The TABLES here are data, the mechanics are
// code — that split is deliberate (thin client): the tables ship as repo
// defaults and are overlaid at runtime by the server-distributed team config
// (src/team-config.js locally, a config store on the server side), so
// growing the vocabulary never requires a client update. Pure module, no
// filesystem/network — shared verbatim with the cloud app like grouping-core.
//
// canonicalsOf("ASP.NET Core / Razor (.cshtml)") → ["dotnet"]
// canonicalsOf("C# / .NET")                      → ["csharp", "dotnet"]
// canonicalsOf("claude_ai_Acme_ai_MCP")          → ["acmeai"]

const DEFAULTS = {
  // Overlay version; the server bumps this when it edits tables. 0 = built-in
  // defaults only.
  version: 0,

  // collapsed-name → canonical token. Keys/values are post-collapse form:
  // lowercase alphanumerics (plus '-').
  aliases: {
    node: 'nodejs',
    nodejs: 'nodejs',
    ts: 'typescript',
    js: 'javascript',
    postgres: 'postgresql',
    postgresql: 'postgresql',
    k8s: 'kubernetes',
    gcp: 'googlecloud',
    golang: 'golang',
    go: 'golang',
    // .NET family — the single biggest name-fragmentation source in the
    // 2026-08 eval (11 of 22 name-variant findings).
    dotnetcore: 'dotnet',
    aspdotnet: 'dotnet',
    aspdotnetcore: 'dotnet',
    aspdotnetcoremvc: 'dotnet',
    razor: 'dotnet',
    cshtml: 'dotnet',
    razorcshtml: 'dotnet',
    // frequent display-form variants
    gsc: 'googlesearchconsole',
    googlesearchconsole: 'googlesearchconsole',
    mongodbatlas: 'mongodb',
    azureappservice: 'azure',
    azureblobstorage: 'azure',
    azurekeyvault: 'azure',
    azurewebapp: 'azure',
    azurefunctions: 'azure',
    chromeextensionmv3: 'chromeextension',
    chromeextensionsmv3: 'chromeextension',
    claudecodehooks: 'claudecode',
    xlsx: 'excel',
  },

  // file extension (as folded into state.tools.extensions) → canonical token.
  ext_tech: {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.py': 'python',
    '.ipynb': 'python',
    '.rb': 'ruby',
    '.go': 'golang',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.php': 'php',
    '.sql': 'sql',
    '.tf': 'terraform',
    '.vue': 'vue',
    '.svelte': 'svelte',
    '.css': 'css',
    '.scss': 'css',
    '.html': 'html',
    '.ps1': 'powershell',
    '.sh': 'bash',
    '.swift': 'swift',
    '.dart': 'dart',
    '.cshtml': 'dotnet',
    '.razor': 'dotnet',
  },

  // shell-command first token → canonical token.
  cmd_tech: {
    npm: 'nodejs',
    npx: 'nodejs',
    node: 'nodejs',
    pnpm: 'nodejs',
    yarn: 'nodejs',
    docker: 'docker',
    'docker-compose': 'docker',
    kubectl: 'kubernetes',
    helm: 'kubernetes',
    terraform: 'terraform',
    psql: 'postgresql',
    mysql: 'mysql',
    sqlite3: 'sqlite',
    aws: 'aws',
    gcloud: 'googlecloud',
    az: 'azure',
    cargo: 'rust',
    rustc: 'rust',
    pip: 'python',
    pip3: 'python',
    python: 'python',
    python3: 'python',
    uv: 'python',
    dotnet: 'dotnet',
    vercel: 'vercel',
    netlify: 'netlify',
    firebase: 'firebase',
    supabase: 'supabase',
    prisma: 'prisma',
    gh: 'github',
    wrangler: 'cloudflare',
  },
};

// Character-level rewrites that must run before tokenization ('#' and '+'
// otherwise vanish in the alphanumeric collapse, turning C# into "c").
const CHAR_SUBS = [
  [/c\+\+/gi, ' cpp '],
  [/c#/gi, ' csharp '],
  [/f#/gi, ' fsharp '],
  [/\.net\b/gi, ' dotnet '],
];

// Trailing qualifier tokens that carry no capability identity ("Gemini API",
// "GitHub CLI", "TrustMRR MCP server"). Only dropped while more tokens remain,
// so single-token names like "fastapi" are never touched.
const DROP_TRAILING = new Set([
  'mcp',
  'server',
  'servers',
  'api',
  'apis',
  'cli',
  'sdk',
  'tool',
  'tools',
]);

function collapseOne(part, aliases) {
  let s = String(part)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' '); // "GitHub CLI (gh)" → "github cli"
  for (const [re, sub] of CHAR_SUBS) s = s.replace(re, sub);
  let tokens = s.split(/[^a-z0-9-]+/).filter(Boolean);
  // MCP server ids arrive as claude_ai_<Name>[_MCP]; the prefix is transport,
  // not technology.
  if (tokens.length > 2 && tokens[0] === 'claude' && tokens[1] === 'ai') tokens = tokens.slice(2);
  while (tokens.length > 1 && DROP_TRAILING.has(tokens[tokens.length - 1])) tokens.pop();
  const key = tokens.join('').replace(/-/g, '');
  return aliases[key] || key;
}

function createNormalizer(tables = DEFAULTS) {
  const aliases = tables.aliases || {};
  const extTech = tables.ext_tech || {};
  const cmdTech = tables.cmd_tech || {};

  // Compound display names ("C# / .NET", "React/Next.js") name several
  // capabilities — split, normalize each, dedupe. Always ≥1 entry. Char subs
  // run BEFORE the split so "C++" doesn't shatter on its own '+'.
  function canonicalsOf(name) {
    let s = String(name);
    for (const [re, sub] of CHAR_SUBS) s = s.replace(re, sub);
    const parts = s
      .split(/[/,+&]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const out = [];
    for (const p of parts.length ? parts : [s]) {
      const c = collapseOne(p, aliases);
      if (c && !out.includes(c)) out.push(c);
    }
    return out.length ? out : ['unknown'];
  }

  return {
    version: tables.version || 0,
    canonicalsOf,
    canonicalOf: (name) => canonicalsOf(name)[0],
    extTech: (ext) => extTech[ext] || null,
    cmdTech: (first) => cmdTech[first] || null,
    tables,
  };
}

// ---- server-overlay plumbing ---------------------------------------------

// Section-level merge: each table is replaced entry-by-entry (overlay entries
// win; defaults survive for keys the overlay doesn't mention).
function mergeTables(defaults, overlay) {
  if (!overlay) return defaults;
  const out = {
    ...defaults,
    version: overlay.version !== undefined ? overlay.version : defaults.version,
  };
  for (const section of ['aliases', 'ext_tech', 'cmd_tech']) {
    if (overlay[section]) out[section] = { ...defaults[section], ...overlay[section] };
  }
  return out;
}

// Strict validation of a server-supplied overlay — this crosses a trust
// boundary (cloud → every client), so unknown keys are dropped and every
// entry is charset- and size-capped. Returns { ok, errors, value } with value
// containing ONLY sanctioned content.
const MAX_ENTRIES = 3000;
const KEY_RE = /^[a-z0-9.@_-]{1,64}$/;
const VAL_RE = /^[a-z0-9-]{1,64}$/;
const EXT_RE = /^\.[a-z0-9]{1,10}$/;

// Capability-catalog sections (consumed by src/capabilities.js, distributed
// on the same overlay). Names/glosses/domains RENDER INTO THE CLASSIFIER
// PROMPT, so their charsets deliberately exclude anything that could break
// out of list position: no newlines, no <>, no backticks, no braces.
const CAP_ID_RE = /^[a-z0-9-]{2,48}$/;
const CAP_NAME_RE = /^[A-Za-z0-9&/+.,()' -]{1,48}$/;
const CAP_GLOSS_RE = /^[A-Za-z0-9&/+.,;:()'" -]{1,140}$/;
const CAP_DOMAIN_RE = /^[A-Za-z0-9&/+.,()' -]{1,32}$/;
const MAX_CAP_ENTRIES = 500;
const MAX_CAP_ALIASES = 1000;
const WATERMARK_RE = /^[0-9T:.Z-]{1,32}$/;

function validateOverlay(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['overlay is not an object'], value: null };
  }
  const version =
    typeof obj.version === 'number' || (typeof obj.version === 'string' && obj.version.length <= 64)
      ? obj.version
      : null;
  if (version === null) errors.push('version missing or invalid');

  const value = { version };
  for (const [section, keyRe, valRe, maxEntries] of [
    ['aliases', KEY_RE, VAL_RE, MAX_ENTRIES],
    ['ext_tech', EXT_RE, VAL_RE, MAX_ENTRIES],
    ['cmd_tech', KEY_RE, VAL_RE, MAX_ENTRIES],
    ['cap_aliases', CAP_ID_RE, CAP_ID_RE, MAX_CAP_ALIASES],
  ]) {
    const src = obj[section];
    if (src === undefined) continue;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      errors.push(`${section} is not an object`);
      continue;
    }
    const entries = Object.entries(src);
    if (entries.length > maxEntries) {
      errors.push(`${section} exceeds ${maxEntries} entries`);
      continue;
    }
    const clean = {};
    for (const [k, v] of entries) {
      if (keyRe.test(k) && typeof v === 'string' && valRe.test(v)) clean[k] = v;
      else errors.push(`${section}: dropped invalid entry ${JSON.stringify(k)}`);
    }
    value[section] = clean;
  }

  // capabilities: { id -> {name, gloss?, domain?} } — object values, so it
  // gets its own pass with per-field charset caps (see CAP_* above).
  if (obj.capabilities !== undefined) {
    const src = obj.capabilities;
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
      errors.push('capabilities is not an object');
    } else if (Object.keys(src).length > MAX_CAP_ENTRIES) {
      errors.push(`capabilities exceeds ${MAX_CAP_ENTRIES} entries`);
    } else {
      const clean = {};
      for (const [id, e] of Object.entries(src)) {
        const ok =
          CAP_ID_RE.test(id) &&
          e &&
          typeof e === 'object' &&
          !Array.isArray(e) &&
          typeof e.name === 'string' &&
          CAP_NAME_RE.test(e.name) &&
          (e.gloss === undefined || (typeof e.gloss === 'string' && CAP_GLOSS_RE.test(e.gloss))) &&
          (e.domain === undefined ||
            (typeof e.domain === 'string' && CAP_DOMAIN_RE.test(e.domain)));
        if (ok) {
          clean[id] = {
            name: e.name,
            ...(e.gloss !== undefined ? { gloss: e.gloss } : {}),
            ...(e.domain !== undefined ? { domain: e.domain } : {}),
          };
        } else {
          errors.push(`capabilities: dropped invalid entry ${JSON.stringify(id)}`);
        }
      }
      value.capabilities = clean;
    }
  }

  // Optional operator watermark: sessions classified before this instant
  // become eligible for re-classification (see watcher rederive sweep).
  if (obj.reclassify_capabilities_before !== undefined) {
    const w = obj.reclassify_capabilities_before;
    if (typeof w === 'string' && WATERMARK_RE.test(w) && !Number.isNaN(Date.parse(w))) {
      value.reclassify_capabilities_before = w;
    } else {
      errors.push('reclassify_capabilities_before invalid (ISO-8601 string required)');
    }
  }

  return { ok: version !== null, errors, value: version !== null ? value : null };
}

module.exports = { DEFAULTS, createNormalizer, mergeTables, validateOverlay };
