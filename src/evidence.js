'use strict';
// Deterministic technology evidence: combines LLM claims with tool evidence
// from session state. Extracted from the classifier so the FOLD can re-derive
// it — `classification.technologies` is derived data computed from
// `technologies_raw` (the LLM's untouched claims) + state.tools + the current
// normalization tables. A table update therefore fixes every stored session
// retroactively on its next fold, with zero classifier calls.
//
// Evidence rules (2026-08 eval, findings F2/F8):
// - matching is EXACT on canonical names — no substring matching ("Java" can
//   never ride on "javascript" evidence again);
// - only EDITED-file extensions corroborate hands_on; read-only access is
//   recorded separately (state.tools.extensions_read) and proves nothing.
const teamConfig = require('./team-config');
const caps = require('./capabilities');

// Extracts [{token, source}] deterministic evidence from session tool state.
function collectToolEvidence(state) {
  const norm = teamConfig.normalizer();
  const out = [];
  const tools = state.tools || {};
  for (const ext of Object.keys(tools.extensions || {})) {
    const tech = norm.extTech(ext);
    if (tech) out.push({ token: tech, source: `tool:${ext}_files` });
  }
  for (const cmd of tools.bash_commands || []) {
    const first = cmd.trim().split(/\s+/)[0];
    const tech = norm.cmdTech(first);
    if (tech) out.push({ token: tech, source: `tool:${first}_command` });
  }
  for (const server of tools.mcp_servers || []) {
    out.push({ token: norm.canonicalOf(server), source: `tool:mcp_${server}`, mcpName: server });
  }
  for (const dep of tools.dependencies_observed || []) {
    out.push({ token: norm.canonicalOf(dep), source: `tool:dependency_${dep}` });
  }
  return out;
}

// Exact canonical equality only. A claim may name several capabilities
// ("C# / .NET") — it matches a token when ANY of its canonicals does.
function matchesToken(techName, token) {
  return teamConfig.normalizer().canonicalsOf(techName).includes(token);
}

// Combines LLM technology claims with deterministic tool evidence:
// - tool evidence for a claimed tech → force hands_on, extend basis, verified
// - zero tool usage in session → cap everything at "discussed"
// - MCP servers used but not claimed → added as verified hands_on techs
function mergeEvidence(state, technologies) {
  const norm = teamConfig.normalizer();
  const evidence = collectToolEvidence(state);
  const hasTools = (state.counts && state.counts.tool_uses > 0) || false;
  const out = [];
  const matchedTokens = new Set();

  for (const t of technologies) {
    const canonicals = norm.canonicalsOf(t.name);
    const matches = evidence.filter((e) => canonicals.includes(e.token));
    let level = t.evidence;
    const basis = ['semantic'];
    if (matches.length > 0) {
      level = 'hands_on';
      for (const m of matches) {
        if (!basis.includes(m.source)) basis.push(m.source);
        matchedTokens.add(m.token);
      }
    }
    if (!hasTools && level === 'hands_on') level = 'discussed'; // conversation cannot be hands-on
    out.push({
      name: t.name,
      canonical: canonicals[0],
      ...(canonicals.length > 1 ? { canonicals } : {}),
      evidence: level,
      basis,
      // verified = corroborated by deterministic tool evidence; a hands_on
      // with verified:false is the LLM's judgment alone.
      verified: basis.some((b) => b.startsWith('tool:')),
    });
  }

  // Surface MCP-server usage the LLM missed — strong deterministic signal.
  for (const e of evidence) {
    if (!e.mcpName || matchedTokens.has(e.token)) continue;
    if (out.some((t) => (t.canonicals || [t.canonical]).includes(e.token))) continue;
    out.push({ name: e.mcpName, canonical: e.token, evidence: 'hands_on', basis: [e.source], verified: true });
    matchedTokens.add(e.token);
  }
  return out;
}

// Fold-time derivation. technologies_raw is the durable LLM output (owned by
// the classification); technologies is always recomputed from it. Legacy
// classifications (pre-raw) get their merged list adopted as raw once.
function deriveTechnologies(state) {
  const cls = state.classification;
  if (!cls) return;
  if (!Array.isArray(cls.technologies_raw)) {
    cls.technologies_raw = (cls.technologies || []).map((t) => ({ name: t.name, evidence: t.evidence }));
  }
  cls.technologies = mergeEvidence(state, cls.technologies_raw);
}

// Business capabilities follow the same raw-twin contract: raw ids from the
// classifier -> alias-chase -> filter to the CURRENT catalog -> [{id, name,
// domain}]. Catalog renames/merges/additions therefore correct all history on
// the next fold with zero classifier calls, and ids the model picked before
// an entry existed resurrect when it is added. Zero-turn gate: a session with
// no completed reply performed no business capability (raw stays untouched,
// so a later turn restores the claims on refold — same reversibility as the
// zero-tool "discussed" cap for technologies).
function resolveCapabilities(rawIds, turns) {
  if (!turns) return [];
  const tables = teamConfig.capabilities();
  const out = [];
  const seen = new Set();
  for (const id of rawIds || []) {
    const cur = caps.resolveId(tables, id);
    if (cur && !seen.has(cur)) {
      seen.add(cur);
      out.push(caps.entryOf(tables, cur));
    }
  }
  return out;
}

function deriveBusinessCapabilities(state) {
  const cls = state.classification;
  if (!cls) return;
  // Legacy classifications (pre-capability) get an empty raw twin — the model
  // was never asked, so nothing may be fabricated for them.
  if (!Array.isArray(cls.business_capabilities_raw)) cls.business_capabilities_raw = [];
  cls.business_capabilities = resolveCapabilities(cls.business_capabilities_raw, (state.counts || {}).turns || 0);
}

module.exports = {
  collectToolEvidence,
  matchesToken,
  mergeEvidence,
  deriveTechnologies,
  resolveCapabilities,
  deriveBusinessCapabilities,
};
