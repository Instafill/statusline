'use strict';
// THE definition of "session content" for team uploads - the one list both
// ends enforce. Since 2026-08-17 content-stripping is a HARD RULE, not an
// option: the uploader strips before sending, and cloud ingest strips again.
// Prompt text, assistant excerpts, digest text, raw command text and search
// queries never reach the cloud; production classification, tool evidence,
// counts, paths and git identity flow unchanged.
//
// Pure module: shared verbatim with the cloud app (shipped by deploy.ps1), so
// keep it dependency-free like grouping-core.

// Experimental semantic records use reserved local-only key families. Match
// families, not schema versions: otherwise adding work_episode_v2 (or nesting
// an atom under diagnostics) could silently cross the upload boundary until a
// two-item denylist was updated. Production reporting uses
// business_capabilities*, which is deliberately outside these prefixes.
function isLocalOnlyKey(key) {
  return /^(?:capability_|provider_neutral_evidence(?:_|$)|evidence_(?:events?|streams?|envelopes?|bindings?)(?:_|$)|episode_(?:semantic|evidence|binding)(?:_|$)|work_(?:episodes?|atoms?|units?|evidence|propositions?)(?:_|$)|participant_(?:evaluation|review|study)(?:_|$)|experimental_(?:semantic|capabilit))/i.test(
    String(key)
  );
}

function stripLocalOnlySemantics(value) {
  if (Array.isArray(value)) return value.map(stripLocalOnlySemantics);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isLocalOnlyKey(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    out[key] = stripLocalOnlySemantics(child);
  }
  return out;
}

function stripContent(doc) {
  // Both the client and cloud run this recursive semantic boundary before the
  // established content projection below.
  const out = { ...stripLocalOnlySemantics(doc), prompts: [], assistant_excerpts: [] };
  if (doc.digest) {
    const { text, ...digestMeta } = doc.digest;
    out.digest = stripLocalOnlySemantics(digestMeta); // keep hashes/timing, not readable text
  }
  if (doc.tools) {
    out.tools = { ...stripLocalOnlySemantics(doc.tools), bash_commands: [] };
    if (doc.tools.web) out.tools.web = { ...stripLocalOnlySemantics(doc.tools.web), search_queries: [] };
  }
  // Rich semantic experiments stay local until their independent privacy and
  // quality gates pass; production business_capabilities* remain untouched.
  if (doc.classification) out.classification = stripLocalOnlySemantics(doc.classification);
  return out;
}

module.exports = { isLocalOnlyKey, stripLocalOnlySemantics, stripContent };
