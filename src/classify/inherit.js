'use strict';
// Classification inheritance: a continuation session (resume/compact/fork) in
// the same project as a recently LLM-classified session reuses that
// classification instead of spending a classifier call. Conservative by
// design — any doubt (no donor, old donor, diverged tool evidence) falls
// through to the real classifier, and stale sessions never inherit (they
// already have a classification and accumulated enough new activity to
// deserve a real re-look). Manual triggers bypass this in the caller.
//
// Siblings are computed from session states with the same deterministic key
// grouping uses (git root, else cwd) rather than projects.json, which can lag
// behind a session that appeared mid-run. Manual project moves in
// corrections.json are not consulted; missing an inheritance just costs one
// classifier call.
const sessions = require('../watcher/sessions');
const { collectToolEvidence, mergeEvidence, matchesToken } = require('./classifier');

const CONTINUATION_SOURCES = new Set(['resume', 'compact', 'fork']);

function normPath(p) {
  return String(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

function projectKeyOf(s) {
  if (s.git_root) return 'git_root|' + normPath(s.git_root);
  if (s.primary_cwd) return 'cwd|' + normPath(s.primary_cwd);
  return null;
}

// Other sessions sharing this session's deterministic project key.
function projectSiblings(state) {
  const key = projectKeyOf(state);
  if (!key) return [];
  return sessions
    .listSessions()
    .filter((o) => o.session_id !== state.session_id && projectKeyOf(o) === key);
}

function findDonor(state, inheritCfg) {
  const maxAgeMs = (inheritCfg.max_age_hours || 72) * 3600000;
  let best = null;
  for (const s of projectSiblings(state)) {
    const cls = s.classification;
    if (!cls || !s.classified_at) continue;
    const meta = cls._meta || {};
    // Only real LLM results seed inheritance — never chain inherited or
    // heuristic classifications (errors would compound silently).
    if (meta.classifier && meta.classifier !== 'claude-cli') continue;
    if (Date.now() - new Date(s.classified_at).getTime() > maxAgeMs) continue;
    if (!best || s.classified_at > best.classified_at) best = s;
  }
  return best;
}

// Returns an inherited classification object, or null when the session must
// go to the real classifier.
function tryInherit(state, cfg, trigger) {
  const inheritCfg = (cfg.classifier && cfg.classifier.inherit) || {};
  if (inheritCfg.enabled === false) return null;
  if (state.classification) return null; // stale/failed re-runs use the real classifier
  if (!(state.sources || []).some((s) => CONTINUATION_SOURCES.has(s))) return null;

  const donor = findDonor(state, inheritCfg);
  if (!donor) return null;
  const donorCls = donor.classification;

  // Diverged tool evidence means new kind of work → real classification.
  const tokens = [...new Set(collectToolEvidence(state).map((e) => e.token))];
  if (tokens.length > 0) {
    const donorNames = (donorCls.technologies || []).map((t) => t.name);
    const matched = tokens.filter((tok) => donorNames.some((n) => matchesToken(n, tok))).length;
    const minOverlap =
      inheritCfg.min_token_overlap === undefined ? 0.5 : inheritCfg.min_token_overlap;
    if (matched / tokens.length < minOverlap) return null;
  }

  const { _meta, ...fields } = donorCls;
  return {
    ...fields,
    // Re-derive levels/basis from THIS session's evidence: a zero-tool
    // continuation shows the donor's hands_on techs as discussed here.
    technologies: mergeEvidence(
      state,
      (donorCls.technologies || []).map((t) => ({ name: t.name, evidence: t.evidence }))
    ),
    continuation: true,
    confidence: Math.round(Math.max(0.1, (donorCls.confidence || 0.5) * 0.8) * 100) / 100,
    rationale:
      `Inherited from session ${String(donor.session_id).slice(0, 8)} (continuation in the same project). ${donorCls.rationale || ''}`.slice(
        0,
        400
      ),
    _meta: {
      model: null,
      classifier: 'inherited',
      inherited_from: donor.session_id,
      trigger: trigger || null,
      classified_at: new Date().toISOString(),
      digest_sha256: null,
      attempts: 0,
      duration_ms: 0,
    },
  };
}

module.exports = { tryInherit, projectSiblings };
