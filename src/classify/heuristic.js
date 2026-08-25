'use strict';
// Deterministic fallback classification used when the LLM classifier is
// unreachable (logged out, offline, timing out). Category and semantic fields
// come from this project's previously classified sessions; technologies come
// from tool evidence alone. Deliberately low confidence and marked
// _meta.classifier = 'heuristic' so the scheduler upgrades it with a real
// classification once the classifier works again.
const { collectToolEvidence, mergeEvidence } = require('./classifier');
const { projectSiblings } = require('./inherit');

// Display names for canonical evidence tokens (fallback: the token itself).
const TECH_DISPLAY = {
  nodejs: 'Node.js',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  python: 'Python',
  golang: 'Go',
  rust: 'Rust',
  csharp: 'C#',
  dotnet: '.NET',
  java: 'Java',
  kotlin: 'Kotlin',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  dart: 'Dart',
  vue: 'Vue',
  svelte: 'Svelte',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  bash: 'Bash',
  powershell: 'PowerShell',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  terraform: 'Terraform',
  aws: 'AWS',
  googlecloud: 'Google Cloud',
  azure: 'Azure',
  github: 'GitHub',
  vercel: 'Vercel',
  netlify: 'Netlify',
  firebase: 'Firebase',
  supabase: 'Supabase',
  prisma: 'Prisma',
  cloudflare: 'Cloudflare',
};

function workDepthOf(counts) {
  if (counts.turns <= 1 && counts.tool_uses === 0) return 'trivial';
  if (counts.turns <= 3 && counts.tool_uses < 5) return 'shallow';
  return 'substantive';
}

function heuristicClassification(state, { trigger, digest_sha256, reason } = {}) {
  const counts = state.counts || { prompts: 0, turns: 0, tool_uses: 0 };
  const hasTools = counts.tool_uses > 0;

  // Project history: category votes plus the most recent classified sibling
  // for the semantic fields a heuristic cannot derive.
  const votes = {};
  let donor = null;
  for (const s of projectSiblings(state)) {
    const cls = s.classification;
    if (!cls) continue;
    votes[cls.work_category] = (votes[cls.work_category] || 0) + 1;
    if (
      cls.work_type &&
      cls.work_type !== 'unknown' &&
      (!donor || (s.classified_at || '') > (donor.classified_at || ''))
    ) {
      donor = s;
    }
  }
  let category = 'unknown';
  let bestVotes = 0;
  for (const [cat, n] of Object.entries(votes)) {
    if (cat !== 'unknown' && n > bestVotes) {
      category = cat;
      bestVotes = n;
    }
  }
  const donorCls = donor ? donor.classification : null;

  const tokens = [...new Set(collectToolEvidence(state).map((e) => e.token))];
  const technologies = mergeEvidence(
    state,
    tokens.map((tok) => ({ name: TECH_DISPLAY[tok] || tok, evidence: 'hands_on' }))
  );

  return {
    schema_version: 1,
    professional_work: category === 'client_work' || category === 'internal_work' || hasTools,
    work_category: category,
    work_type: donorCls ? donorCls.work_type : hasTools ? 'technical work' : 'unknown',
    industry: donorCls ? donorCls.industry || [] : [],
    business_function: donorCls ? donorCls.business_function || [] : [],
    tasks: [],
    // A deterministic fallback makes no business-level judgments: tasks and
    // capabilities stay empty (donor copy above deliberately does NOT extend
    // to business_capabilities).
    business_capabilities: [],
    business_capabilities_raw: [],
    technologies,
    work_stage: 'unknown',
    work_depth: workDepthOf(counts),
    project_hint: donorCls ? donorCls.project_hint || '' : '',
    continuation: (state.sources || []).some((s) => ['resume', 'compact', 'fork'].includes(s)),
    confidence: 0.25,
    rationale:
      `Heuristic fallback (classifier unavailable: ${reason || 'error'}) — derived from tool evidence and project history. Replaced automatically once the classifier is reachable.`.slice(
        0,
        400
      ),
    _meta: {
      model: null,
      classifier: 'heuristic',
      fallback_reason: reason || null,
      trigger: trigger || null,
      classified_at: new Date().toISOString(),
      digest_sha256: digest_sha256 || null,
      attempts: 0,
      duration_ms: 0,
    },
  };
}

module.exports = { heuristicClassification };
