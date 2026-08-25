'use strict';
// Validation/coercion of the classification JSON coming back from the LLM.
// Lenient where safe (coerce, default, clamp), strict on core fields.

const WORK_CATEGORIES = ['client_work', 'internal_work', 'learning', 'personal', 'unknown'];
const WORK_DEPTHS = ['substantive', 'shallow', 'trivial'];
const EVIDENCE_LEVELS = ['mentioned', 'discussed', 'hands_on'];
const WORK_STAGES = [
  'research',
  'planning',
  'implementation',
  'debugging',
  'review',
  'analysis',
  'writing',
  'configuration',
  'operations',
  'other',
  'unknown',
];

function asString(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

function asStringArray(v) {
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

function asEnum(v, allowed, fallback, errors, field) {
  if (typeof v === 'string' && allowed.includes(v)) return v;
  if (v !== undefined) errors.push(`${field}: "${v}" not in [${allowed.join(', ')}]`);
  return fallback;
}

function validate(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['result is not a JSON object'], value: null };
  }
  if (typeof obj.professional_work !== 'boolean') {
    errors.push('professional_work must be a boolean');
  }
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) {
    errors.push('confidence must be a number');
    confidence = 0;
  }
  confidence = Math.min(1, Math.max(0, confidence));

  const technologies = [];
  if (obj.technologies !== undefined && !Array.isArray(obj.technologies)) {
    errors.push('technologies must be an array');
  }
  for (const t of Array.isArray(obj.technologies) ? obj.technologies : []) {
    if (typeof t === 'string' && t.trim()) {
      technologies.push({ name: t.trim(), evidence: 'mentioned', basis: ['semantic'] });
    } else if (t && typeof t === 'object' && typeof t.name === 'string' && t.name.trim()) {
      technologies.push({
        name: t.name.trim(),
        evidence: asEnum(
          t.evidence,
          EVIDENCE_LEVELS,
          'mentioned',
          errors,
          'technologies[].evidence'
        ),
        basis: ['semantic'],
      });
    }
  }

  const value = {
    schema_version: 1,
    professional_work: obj.professional_work === true,
    work_category: asEnum(obj.work_category, WORK_CATEGORIES, 'unknown', errors, 'work_category'),
    work_type: asString(obj.work_type, 'unknown'),
    industry: asStringArray(obj.industry),
    business_function: asStringArray(obj.business_function),
    tasks: asStringArray(obj.tasks),
    // Deliberately catalog-agnostic: unknown ids survive into the raw twin so
    // a later catalog addition picks them up retroactively (deriveBusiness-
    // Capabilities filters against the CURRENT catalog on every fold).
    business_capabilities: [
      ...new Set(asStringArray(obj.business_capabilities).map((s) => s.toLowerCase())),
    ].slice(0, 4),
    technologies,
    work_stage: asEnum(obj.work_stage, WORK_STAGES, 'unknown', errors, 'work_stage'),
    work_depth: asEnum(obj.work_depth, WORK_DEPTHS, 'shallow', errors, 'work_depth'),
    project_hint: asString(obj.project_hint, '').slice(0, 100),
    continuation: obj.continuation === true,
    confidence,
    rationale: asString(obj.rationale, '').slice(0, 400),
  };

  // Core fields must be usable; enum coercions above are warnings, not fatal.
  const fatal = errors.filter(
    (e) =>
      e.startsWith('professional_work') ||
      e.startsWith('confidence') ||
      e === 'result is not a JSON object' ||
      e === 'technologies must be an array'
  );
  return { ok: fatal.length === 0, errors, value: fatal.length === 0 ? value : null };
}

module.exports = { validate, WORK_CATEGORIES, WORK_DEPTHS, EVIDENCE_LEVELS, WORK_STAGES };
