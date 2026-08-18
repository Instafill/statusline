'use strict';
// Classifier boundary: adapter dispatch, retry, validation, egress logging,
// and the deterministic evidence merge that combines LLM claims with tool
// evidence. Swap the underlying method via config.classifier.kind.
const config = require('../config');
const log = require('../util/log');
const egress = require('./egress');
const { buildPrompt } = require('./prompt');
const { validate } = require('./schema');

const ADAPTERS = {
  'claude-cli': () => require('./claude-cli'),
  // 'local': () => require('./local-model')  — future
};

// Deterministic evidence lives in src/evidence.js (tables in
// src/tech-normalize.js, server-overlaid via src/team-config.js); re-exported
// here so inherit.js/heuristic.js and existing tests keep their import site.
const { collectToolEvidence, matchesToken, mergeEvidence } = require('../evidence');

// A session with zero completed turns performed no work — the model only saw
// a request. Cap depth/confidence deterministically (variance-proof, where a
// prompt instruction is not). Mutates value; returns the list of capped fields.
function applyZeroTurnCaps(state, value) {
  if (((state.counts || {}).turns || 0) > 0) return [];
  const capped = [];
  if (value.work_depth === 'substantive') {
    value.work_depth = 'shallow';
    capped.push('work_depth');
  }
  if (value.confidence > 0.5) {
    value.confidence = 0.5;
    capped.push('confidence');
  }
  return capped;
}

// ---- main entry -----------------------------------------------------------

// Returns { ok:true, classification } or { ok:false, error, outcome }.
async function classifySession(state, digestText, ctx = {}) {
  const cfg = config.load().classifier;
  const makeAdapter = ADAPTERS[cfg.kind];
  if (!makeAdapter) return { ok: false, outcome: 'config_error', error: `unknown classifier kind "${cfg.kind}"` };
  const adapter = makeAdapter();

  let corrective = null;
  let lastError = null;
  let lastOutcome = 'parse_error';
  // Expense across ALL attempts of this classification (retries included), so
  // the session doc carries what the classification actually cost.
  const spent = { cost_usd: 0, input_tokens: 0, output_tokens: 0, any: false };

  for (let attemptNo = 1; attemptNo <= 1 + cfg.max_retries; attemptNo++) {
    const prompt = buildPrompt(digestText, corrective);
    const t0 = Date.now();
    log.info(`classifier egress: session ${state.session_id} attempt ${attemptNo} → ${adapter.kind} (${cfg.model}), ${digestText.length} chars`);
    const res = await adapter.attempt(prompt, cfg);
    const duration = Date.now() - t0;
    if (res.cost_usd != null) {
      spent.cost_usd += res.cost_usd;
      spent.any = true;
    }
    if (res.input_tokens != null) spent.input_tokens += res.input_tokens;
    if (res.output_tokens != null) spent.output_tokens += res.output_tokens;

    let outcome = res.outcome;
    let classification = null;
    if (res.outcome === 'ok') {
      const v = validate(res.json);
      if (v.ok) {
        // technologies_raw is the durable LLM output; technologies is derived
        // from it here AND on every fold (src/evidence.js), so normalization-
        // table updates apply retroactively without a classifier call.
        const raw = v.value.technologies.map((t) => ({ name: t.name, evidence: t.evidence }));
        const value = { ...v.value, technologies_raw: raw, technologies: mergeEvidence(state, raw) };
        const capped = applyZeroTurnCaps(state, value);
        classification = {
          ...value,
          _meta: {
            model: cfg.model,
            effort: cfg.effort || null,
            actual_model: res.actual_model || null,
            classifier: adapter.kind,
            trigger: ctx.trigger || null,
            classified_at: new Date().toISOString(),
            digest_sha256: ctx.digest_sha256 || null,
            attempts: attemptNo,
            duration_ms: duration,
            cost_usd: spent.any ? Math.round(spent.cost_usd * 1e6) / 1e6 : null,
            input_tokens: spent.input_tokens || null,
            output_tokens: spent.output_tokens || null,
            validation_warnings: v.errors,
            ...(capped.length ? { zero_turn_caps: capped } : {}),
          },
        };
      } else {
        outcome = 'parse_error';
        lastError = `validation failed: ${v.errors.join('; ')}`;
      }
    } else {
      lastError = res.detail;
    }

    egress.record({
      session_id: state.session_id,
      kind: adapter.kind,
      model: cfg.model, // requested
      actual_model: res.actual_model || null, // what the API actually served
      cost_usd: res.cost_usd != null ? res.cost_usd : null,
      input_tokens: res.input_tokens != null ? res.input_tokens : null,
      output_tokens: res.output_tokens != null ? res.output_tokens : null,
      cache_read_tokens: res.cache_read_tokens != null ? res.cache_read_tokens : null,
      trigger: ctx.trigger || null,
      digest_chars: digestText.length,
      digest_sha256: ctx.digest_sha256 || null,
      outcome,
      duration_ms: duration,
      attempt: attemptNo,
    });

    if (classification) return { ok: true, classification };
    lastOutcome = outcome;
    if (outcome === 'timeout' || outcome === 'auth_error') break; // retrying won't help quickly
    corrective = `Your previous output failed validation (${(lastError || '').slice(0, 300)}). Output ONLY the JSON object with every required field.`;
  }

  // Heuristic fallback: don't leave the session unusable just because the
  // classifier is unreachable. Low confidence, marked _meta.classifier =
  // 'heuristic'; the scheduler upgrades it once the classifier works again.
  if (cfg.heuristic_fallback !== false) {
    const { heuristicClassification } = require('./heuristic'); // lazy: heuristic requires this module
    const classification = heuristicClassification(state, {
      trigger: ctx.trigger,
      digest_sha256: ctx.digest_sha256,
      reason: lastOutcome,
    });
    log.warn(`classifier unreachable (${lastOutcome}) — heuristic fallback for session ${state.session_id}`);
    return { ok: true, classification, degraded: true, outcome: lastOutcome, error: lastError || lastOutcome };
  }
  return { ok: false, outcome: lastOutcome, error: lastError || lastOutcome };
}

module.exports = { classifySession, mergeEvidence, collectToolEvidence, matchesToken, applyZeroTurnCaps };
