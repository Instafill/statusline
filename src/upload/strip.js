'use strict';
// THE definition of "session content" for team uploads — the one list both
// ends enforce. Since 2026-08-17 content-stripping is a HARD RULE, not an
// option: the uploader strips before sending, and the cloud ingest strips
// again so an out-of-date client cannot leak content either. Prompt text,
// assistant excerpts, digest text, raw command text and search queries never
// reach the cloud; classification, tool evidence, counts, paths and git
// identity — everything aggregation actually reads — flow unchanged.
//
// Pure module: shared verbatim with the cloud app (shipped by deploy.ps1),
// so keep it dependency-free like grouping-core.

function stripContent(doc) {
  const out = { ...doc, prompts: [], assistant_excerpts: [] };
  if (doc.digest) {
    const { text, ...digestMeta } = doc.digest;
    out.digest = digestMeta; // keep built_at/chars/sha256 — provable, not readable
  }
  if (doc.tools) {
    out.tools = { ...doc.tools, bash_commands: [] };
    if (doc.tools.web) out.tools.web = { ...doc.tools.web, search_queries: [] };
  }
  return out;
}

module.exports = { stripContent };
