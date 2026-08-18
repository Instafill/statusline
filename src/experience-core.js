'use strict';
// Pure practitioner-experience aggregation shared by the local watcher and the
// cloud server. Consumes session states + the groupSessions() output and emits
// per-practitioner (and org-wide) experience built from DISTINCT PROJECTS,
// never session volume — the anti-inflation contract:
//
//   - reduce within a project first (max evidence, any-verified, max depth),
//     then count projects; nothing ever sums across sessions, so 50 discussed
//     sessions in one project stay 1 project at discussed;
//   - capabilities accrue only from professional work (client/internal, with
//     the user's label corrections winning); learning/personal/unclassified
//     are tallied in totals.excluded, never as experience;
//   - singleton "projects" (catch-all directories) collapse into ONE misc
//     pseudo-bucket per practitioner: at most one project credit, flagged;
//   - the org rollup runs the same reduction over the same global project set,
//     so several practitioners on one engagement stay ONE org project;
//   - uncertainty is carried raw (verified tiers, classifier provenance,
//     min confidence, membership key kind) — a display layer decides what is
//     safe to claim by filtering, never by recomputation.
//
// No filesystem, no clock: callers stamp and persist the result themselves.
const { effectiveClassification, EVIDENCE_WEIGHT } = require('./grouping-core');

const PROFESSIONAL_CATS = new Set(['client_work', 'internal_work']);
const BASIS_CAP = 10;

function canonicalsOfTech(tech) {
  return tech.canonicals || [tech.canonical || String(tech.name).toLowerCase()];
}

// Reduce one practitioner's (or everyone's) sessions WITHIN one project.
// Returns null when no session is included as professional work.
function reduceProject(project, sessionStates, corrections) {
  const red = {
    project_id: project.id,
    project_name: project.name,
    key_kind: project.key.kind,
    engagement_id: project.engagement_id || null,
    misc: !!project.singleton,
    sessions: 0,
    session_ids: [],
    categories: new Set(),
    industries: new Set(),
    depth_max: null,
    techs: {}, // canonical -> {name, max_evidence, verified, verified_max_evidence, sessions, verified_sessions, basis, classifiers, min_confidence, first, last, categories}
    classifiers: new Set(),
    min_confidence: null,
    first_seen: null,
    last_seen: null,
  };
  const depthRank = { substantive: 3, shallow: 2, trivial: 1 };
  for (const s of sessionStates) {
    const corr = corrections.sessions[s.session_id] || {};
    const cls = effectiveClassification(s, corrections);
    if (!cls) continue;
    const cat = corr.label && corr.label !== 'ignore' ? corr.label : cls.work_category;
    // The user's label always wins; otherwise the classifier must both name a
    // professional category AND assert professional_work (contradictory docs
    // are excluded — under-claiming is the safe direction).
    const included = PROFESSIONAL_CATS.has(cat) && (corr.label ? true : cls.professional_work === true);
    if (!included) continue;
    red.sessions++;
    red.session_ids.push(s.session_id);
    red.categories.add(cat);
    for (const ind of cls.industry || []) red.industries.add(ind);
    if (!red.first_seen || s.created_at < red.first_seen) red.first_seen = s.created_at;
    if (!red.last_seen || s.last_event_at > red.last_seen) red.last_seen = s.last_event_at;
    const depth = cls.work_depth || null;
    if (depth && (!red.depth_max || depthRank[depth] > depthRank[red.depth_max])) red.depth_max = depth;
    const via = (cls._meta && cls._meta.classifier) || 'unknown';
    red.classifiers.add(via);
    const conf = typeof cls.confidence === 'number' ? cls.confidence : null;
    if (conf !== null && (red.min_confidence === null || conf < red.min_confidence)) red.min_confidence = conf;
    for (const tech of cls.technologies || []) {
      for (const k of canonicalsOfTech(tech)) {
        const t = red.techs[k] || {
          name: tech.name,
          max_evidence: 'mentioned',
          verified: false,
          verified_max_evidence: null,
          sessions: 0,
          verified_sessions: 0,
          basis: new Set(),
          classifiers: new Set(),
          min_confidence: null,
          first: null,
          last: null,
          categories: new Set(),
        };
        t.sessions++;
        if (EVIDENCE_WEIGHT[tech.evidence] > EVIDENCE_WEIGHT[t.max_evidence]) {
          t.max_evidence = tech.evidence;
          t.name = tech.name;
        }
        if (tech.verified) {
          t.verified = true;
          t.verified_sessions++;
          if (!t.verified_max_evidence || EVIDENCE_WEIGHT[tech.evidence] > EVIDENCE_WEIGHT[t.verified_max_evidence]) {
            t.verified_max_evidence = tech.evidence;
          }
        }
        for (const b of tech.basis || []) t.basis.add(b);
        t.classifiers.add(via);
        if (conf !== null && (t.min_confidence === null || conf < t.min_confidence)) t.min_confidence = conf;
        if (!t.first || s.created_at < t.first) t.first = s.created_at;
        if (!t.last || s.last_event_at > t.last) t.last = s.last_event_at;
        t.categories.add(cat);
        red.techs[k] = t;
      }
    }
  }
  return red.sessions > 0 ? red : null;
}

// Merge N singleton-project reductions into one 'misc' pseudo-project so all
// miscellaneous work combined can never contribute more than one project
// credit to any capability.
function mergeMisc(reductions) {
  if (!reductions.length) return null;
  const out = reductions[0];
  out.project_id = 'misc';
  out.project_name = 'Miscellaneous';
  out.key_kind = 'session';
  out.engagement_id = null;
  out.misc = true;
  const depthRank = { substantive: 3, shallow: 2, trivial: 1 };
  for (const red of reductions.slice(1)) {
    out.sessions += red.sessions;
    out.session_ids.push(...red.session_ids);
    for (const c of red.categories) out.categories.add(c);
    for (const i of red.industries) out.industries.add(i);
    for (const c of red.classifiers) out.classifiers.add(c);
    if (red.depth_max && (!out.depth_max || depthRank[red.depth_max] > depthRank[out.depth_max])) out.depth_max = red.depth_max;
    if (red.min_confidence !== null && (out.min_confidence === null || red.min_confidence < out.min_confidence)) {
      out.min_confidence = red.min_confidence;
    }
    if (!out.first_seen || (red.first_seen && red.first_seen < out.first_seen)) out.first_seen = red.first_seen;
    if (!out.last_seen || (red.last_seen && red.last_seen > out.last_seen)) out.last_seen = red.last_seen;
    for (const [k, t] of Object.entries(red.techs)) {
      const cur = out.techs[k];
      if (!cur) {
        out.techs[k] = t;
        continue;
      }
      cur.sessions += t.sessions;
      cur.verified_sessions += t.verified_sessions;
      if (EVIDENCE_WEIGHT[t.max_evidence] > EVIDENCE_WEIGHT[cur.max_evidence]) {
        cur.max_evidence = t.max_evidence;
        cur.name = t.name;
      }
      if (t.verified) cur.verified = true;
      if (t.verified_max_evidence && (!cur.verified_max_evidence || EVIDENCE_WEIGHT[t.verified_max_evidence] > EVIDENCE_WEIGHT[cur.verified_max_evidence])) {
        cur.verified_max_evidence = t.verified_max_evidence;
      }
      for (const b of t.basis) cur.basis.add(b);
      for (const c of t.classifiers) cur.classifiers.add(c);
      if (t.min_confidence !== null && (cur.min_confidence === null || t.min_confidence < cur.min_confidence)) {
        cur.min_confidence = t.min_confidence;
      }
      if (!cur.first || (t.first && t.first < cur.first)) cur.first = t.first;
      if (!cur.last || (t.last && t.last > cur.last)) cur.last = t.last;
      for (const c of t.categories) cur.categories.add(c);
    }
  }
  return out;
}

// Assemble one experience doc from a scope's per-project session attribution.
function buildDoc(practitioner, perProject, corrections) {
  const totals = {
    projects: 0,
    sessions: 0,
    classified_sessions: 0,
    first_seen: null,
    last_seen: null,
    work_category_projects: {},
    excluded: { learning: 0, personal: 0, unclassified: 0, misc_sessions: 0 },
  };
  const realReductions = [];
  const miscReductions = [];
  for (const { project, sessions } of perProject.values()) {
    for (const s of sessions) {
      totals.sessions++;
      if (project.singleton) totals.excluded.misc_sessions++;
      if (!s.created_at || !totals.first_seen || s.created_at < totals.first_seen) totals.first_seen = s.created_at || totals.first_seen;
      if (!totals.last_seen || s.last_event_at > totals.last_seen) totals.last_seen = s.last_event_at;
      const corr = corrections.sessions[s.session_id] || {};
      const cls = effectiveClassification(s, corrections);
      if (!cls) {
        totals.excluded.unclassified++;
        continue;
      }
      totals.classified_sessions++;
      const cat = corr.label && corr.label !== 'ignore' ? corr.label : cls.work_category;
      if (cat === 'learning') totals.excluded.learning++;
      if (cat === 'personal') totals.excluded.personal++;
    }
    const red = reduceProject(project, sessions, corrections);
    if (!red) continue;
    if (red.misc) miscReductions.push(red);
    else realReductions.push(red);
  }
  const misc = mergeMisc(miscReductions);
  const entries = misc ? [...realReductions, misc] : realReductions;

  totals.projects = realReductions.length;
  for (const red of realReductions) {
    for (const cat of red.categories) {
      totals.work_category_projects[cat] = (totals.work_category_projects[cat] || 0) + 1;
    }
  }

  // Roll project reductions up per capability — counting PROJECTS.
  const capMap = {};
  for (const red of entries) {
    for (const [k, t] of Object.entries(red.techs)) {
      const cap = capMap[k] || {
        canonical: k,
        name: t.name,
        distinct_projects: 0,
        verified_projects: 0,
        max_evidence: 'mentioned',
        verified_max_evidence: null,
        first_used: null,
        last_used: null,
        depth_projects: { substantive: 0, shallow: 0, trivial: 0 },
        category_projects: {},
        industries: new Set(),
        projects: [],
        uncertainty: { any_heuristic: false, any_inherited: false, min_confidence: null },
      };
      cap.distinct_projects++;
      if (t.verified) cap.verified_projects++;
      if (EVIDENCE_WEIGHT[t.max_evidence] > EVIDENCE_WEIGHT[cap.max_evidence]) {
        cap.max_evidence = t.max_evidence;
        cap.name = t.name;
      }
      if (t.verified_max_evidence && (!cap.verified_max_evidence || EVIDENCE_WEIGHT[t.verified_max_evidence] > EVIDENCE_WEIGHT[cap.verified_max_evidence])) {
        cap.verified_max_evidence = t.verified_max_evidence;
      }
      if (!cap.first_used || (t.first && t.first < cap.first_used)) cap.first_used = t.first;
      if (!cap.last_used || (t.last && t.last > cap.last_used)) cap.last_used = t.last;
      if (red.depth_max && red.depth_max in cap.depth_projects) cap.depth_projects[red.depth_max]++;
      for (const cat of t.categories) cap.category_projects[cat] = (cap.category_projects[cat] || 0) + 1;
      for (const i of red.industries) cap.industries.add(i);
      if (t.classifiers.has('heuristic')) cap.uncertainty.any_heuristic = true;
      if (t.classifiers.has('inherited')) cap.uncertainty.any_inherited = true;
      if (t.min_confidence !== null && (cap.uncertainty.min_confidence === null || t.min_confidence < cap.uncertainty.min_confidence)) {
        cap.uncertainty.min_confidence = t.min_confidence;
      }
      // The explainability trace: one entry per contributing project.
      cap.projects.push({
        project_id: red.project_id,
        project_name: red.project_name,
        key_kind: red.key_kind,
        engagement_id: red.engagement_id,
        misc: red.misc,
        max_evidence: t.max_evidence,
        verified: t.verified,
        sessions: t.sessions,
        verified_sessions: t.verified_sessions,
        depth_max: red.depth_max,
        first_seen: t.first,
        last_seen: t.last,
        basis: [...t.basis].slice(0, BASIS_CAP),
        classifiers: [...t.classifiers],
        min_confidence: t.min_confidence,
        session_ids: red.session_ids,
      });
      capMap[k] = cap;
    }
  }

  const capabilities = Object.values(capMap)
    .map((c) => ({ ...c, industries: [...c.industries] }))
    .sort(
      (a, b) =>
        b.verified_projects - a.verified_projects ||
        EVIDENCE_WEIGHT[b.max_evidence] - EVIDENCE_WEIGHT[a.max_evidence] ||
        b.distinct_projects - a.distinct_projects ||
        (a.canonical < b.canonical ? -1 : 1)
    );

  return { practitioner, totals, capabilities };
}

// states + groupSessions() output + corrections -> per-practitioner and
// org-wide experience docs. opts:
//   practitionerOf:   (state) => key | null   (cloud: machine->practitioner;
//                                              local: () => 'self')
//   practitionerMeta: (key) => { id, display_name, provisional }
function computeExperience(states, grouped, corrections, opts = {}) {
  const practitionerOf = opts.practitionerOf || (() => 'self');
  const practitionerMeta =
    opts.practitionerMeta || ((key) => ({ id: String(key), display_name: String(key), provisional: false }));
  const bySid = new Map(states.map((s) => [s.session_id, s]));

  const orgPerProject = new Map(); // projId -> {project, sessions}
  const scopes = new Map(); // practKey -> Map(projId -> {project, sessions})
  for (const project of grouped.projects || []) {
    for (const sid of project.session_ids) {
      const s = bySid.get(sid);
      if (!s) continue;
      if (!orgPerProject.has(project.id)) orgPerProject.set(project.id, { project, sessions: [] });
      orgPerProject.get(project.id).sessions.push(s);
      const key = practitionerOf(s);
      if (key === null || key === undefined) continue;
      if (!scopes.has(key)) scopes.set(key, new Map());
      const per = scopes.get(key);
      if (!per.has(project.id)) per.set(project.id, { project, sessions: [] });
      per.get(project.id).sessions.push(s);
    }
  }

  const practitioners = [...scopes.entries()]
    .map(([key, perProject]) => buildDoc(practitionerMeta(key), perProject, corrections))
    .sort((a, b) => (String(a.practitioner.display_name || a.practitioner.id) < String(b.practitioner.display_name || b.practitioner.id) ? -1 : 1));
  const org = buildDoc({ id: 'org', display_name: 'Everyone' }, orgPerProject, corrections);

  return { v: 1, practitioners, org };
}

module.exports = { computeExperience };
