'use strict';
// Pure grouping algorithm shared by the local watcher and the cloud server.
// No filesystem, no clock: callers supply session states + corrections and
// write/stamp the result themselves. Path handling is injectable because the
// local grouper must stay byte-compatible with historical Windows-normalized
// project ids, while the cloud groups paths from mixed-OS machines.
const crypto = require('crypto');
const path = require('path');

// `engagements` is the durable business-identity registry: minted ids claiming
// projects by RAW keys (git_root paths, origin URLs), normalized only at match
// time with the consumer's normKey — one registry entry therefore matches the
// same repo under both the Windows-normalized local ids and slash-normalized
// cloud ids. Shape:
//   engagements: { 'eng_x': { name, kind: 'internal'|'client'|null,
//                             keys: [{kind:'git_root'|'origin', value}], note } }
const EMPTY_CORRECTIONS = { v: 1, sessions: {}, projects: {}, dismissed_merges: [], engagements: {} };

// Historical local normalization (lowercase, / -> \). Changing this would
// change projectIdOf() hashes and orphan every corrections.json project entry.
function windowsNormKey(p) {
  return String(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}

// Cross-platform normalization for the cloud: mixed Windows/POSIX paths from
// different machines fold to forward slashes so clones group together.
function slashNormKey(p) {
  return String(p).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

function crossPlatformBasename(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

const WINDOWS_PATH_OPTS = { normKey: windowsNormKey, sep: '\\', basename: path.basename };
const SLASH_PATH_OPTS = { normKey: slashNormKey, sep: '/', basename: crossPlatformBasename };

function projectIdOf(kind, value) {
  return 'prj_' + crypto.createHash('sha1').update(`${kind}|${value}`).digest('hex').slice(0, 10);
}

// Normalized form of a git remote URL, for EQUALITY only (display keeps the
// raw state value): protocol/user stripped, scp-style host:path folded to
// host/path, trailing .git dropped. Same normalized origin = same repo.
function normOrigin(url) {
  if (!url) return null;
  let u = String(url).trim().toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//, '');
  u = u.replace(/^[^@/]+@/, '');
  u = u.replace(/:([^/\\])/, '/$1');
  u = u.replace(/\.git$/, '').replace(/[\\/]+$/, '');
  return u || null;
}

// Home-style directories are catch-alls: sessions run from them share a cwd
// but not a body of work, so they become per-session singletons (never
// presented as projects) instead of one impure mega-project.
const CATCH_ALL_CWD_RES = [
  /^[a-z]:[\\/]users[\\/][^\\/]+$/, // Windows home (either normalization)
  /^[\\/]home[\\/][^\\/]+$/, // Linux home
  /^[\\/]users[\\/][^\\/]+$/, // macOS home
];

function isCatchAllCwd(normValue) {
  return CATCH_ALL_CWD_RES.some((re) => re.test(normValue));
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'project',
  'app', 'application', 'system', 'work', 'client', 'new', 'main',
]);

function hintTokens(hints) {
  const out = new Set();
  for (const h of hints) {
    for (const w of String(h).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
    }
  }
  return out;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const EVIDENCE_WEIGHT = { hands_on: 1.0, discussed: 0.5, mentioned: 0.25 };

function weightedTechJaccard(techsA, techsB) {
  const keys = new Set([...Object.keys(techsA), ...Object.keys(techsB)]);
  let inter = 0;
  let union = 0;
  for (const k of keys) {
    const wa = techsA[k] || 0;
    const wb = techsB[k] || 0;
    inter += Math.min(wa, wb);
    union += Math.max(wa, wb);
  }
  return union > 0 ? inter / union : 0;
}

// Classification with the user's per-field overrides applied.
function effectiveClassification(state, corrections) {
  const cls = state.classification;
  if (!cls) return null;
  const corr = corrections.sessions[state.session_id];
  if (!corr || !corr.field_overrides) return cls;
  return { ...cls, ...corr.field_overrides };
}

function resolveMerged(corrections, id, depth = 0) {
  const entry = corrections.projects[id];
  if (entry && entry.merged_into && depth < 10) return resolveMerged(corrections, entry.merged_into, depth + 1);
  return id;
}

const EVIDENCE_ROWS_CAP = 25;

// states + corrections -> { projects: [...] } (sorted, not stamped/persisted).
function groupSessions(states, corrections, opts = WINDOWS_PATH_OPTS) {
  const { normKey, sep, basename } = opts;
  const active = states.filter((s) => (corrections.sessions[s.session_id] || {}).label !== 'ignore');

  // Pass 1: deterministic keys, with cwd-inside-git-root absorption. A linked
  // worktree folds into its parent repo (git_main_root), so the parent's
  // project id — unchanged — absorbs the worktree's sessions; both the parent
  // root and the worktree's own path absorb loose cwds beneath them.
  const gitRoots = new Map(); // normalized root -> [key, basis]
  for (const s of active) {
    if (s.git_main_root) {
      const parent = { kind: 'git_root', value: normKey(s.git_main_root) };
      gitRoots.set(normKey(s.git_main_root), [parent, 'cwd_absorbed']);
      if (s.git_root) gitRoots.set(normKey(s.git_root), [parent, 'cwd_absorbed']);
    } else if (s.git_root) {
      gitRoots.set(normKey(s.git_root), [{ kind: 'git_root', value: normKey(s.git_root) }, 'cwd_absorbed']);
    }
  }

  const keyFor = (s) => {
    if (s.git_main_root) return [{ kind: 'git_root', value: normKey(s.git_main_root) }, 'worktree'];
    if (s.git_root) return [{ kind: 'git_root', value: normKey(s.git_root) }, 'git_root'];
    if (s.primary_cwd) {
      const cwd = normKey(s.primary_cwd);
      for (const [root, [key, basis]] of gitRoots) {
        if (cwd === root || cwd.startsWith(root + sep)) return [key, basis];
      }
      if (isCatchAllCwd(cwd)) return [{ kind: 'session', value: s.session_id }, 'singleton'];
      return [{ kind: 'cwd', value: cwd }, 'cwd'];
    }
    return [{ kind: 'session', value: s.session_id }, 'singleton'];
  };

  const projects = new Map(); // id -> project
  const ensureProject = (id, key) => {
    if (!projects.has(id)) {
      projects.set(id, { id, key, session_ids: [], membership: {}, _states: [] });
    }
    return projects.get(id);
  };

  for (const s of active) {
    const corr = corrections.sessions[s.session_id] || {};
    let id;
    let key;
    let basis;
    if (corr.project_id) {
      id = resolveMerged(corrections, corr.project_id);
      key = { kind: 'manual', value: id };
      basis = 'manual';
    } else {
      [key, basis] = keyFor(s);
      id = resolveMerged(corrections, projectIdOf(key.kind, key.value));
    }
    // Prefer the deterministic key of the merge target when it exists already.
    const proj = projects.has(id) ? projects.get(id) : ensureProject(id, key);
    proj.session_ids.push(s.session_id);
    proj.membership[s.session_id] = basis;
    proj._states.push(s);
  }

  // Engagement overlay: declared identity outranks mechanical keys. Every
  // project matching a registry key (by path or by member origin) folds into
  // one project per engagement, keyed and named by the registry.
  const engagements = corrections.engagements || {};
  const engDefs = Object.entries(engagements).map(([engId, e]) => {
    const pathKeys = new Set();
    const originKeys = new Set();
    for (const k of e.keys || []) {
      if (!k || !k.value) continue;
      if (k.kind === 'origin') {
        const o = normOrigin(k.value);
        if (o) originKeys.add(o);
      } else {
        pathKeys.add(normKey(k.value));
      }
    }
    return { engId, e, pathKeys, originKeys };
  });
  if (engDefs.length) {
    const engFor = (proj) => {
      for (const d of engDefs) {
        if ((proj.key.kind === 'git_root' || proj.key.kind === 'cwd') && d.pathKeys.has(proj.key.value)) return d;
        if (d.originKeys.size) {
          for (const s of proj._states) {
            const o = normOrigin(s.git_origin);
            if (o && d.originKeys.has(o)) return d;
          }
        }
      }
      return null;
    };
    for (const [id, proj] of [...projects]) {
      const d = engFor(proj);
      if (!d) continue;
      const target = projects.get(d.engId) || ensureProject(d.engId, { kind: 'engagement', value: d.engId });
      target.key = { kind: 'engagement', value: d.engId };
      target.engagement_id = d.engId;
      target.engagement_kind = d.e.kind || null;
      target._engagement = d.e;
      if (target !== proj) {
        target.session_ids.push(...proj.session_ids);
        Object.assign(target.membership, proj.membership);
        target._states.push(...proj._states);
        projects.delete(id);
      }
    }
  }

  // Aggregate.
  for (const proj of projects.values()) {
    const agg = {
      work_category_votes: {},
      technologies: [], // filled from techMap below
      industries: [],
      tasks_recent: [],
      depths: { substantive: 0, shallow: 0, trivial: 0 },
      via: {},
      active_days: 0,
      machine_ids: [],
      first_seen: null,
      last_seen: null,
      total_sessions: proj._states.length,
      classified_sessions: 0,
    };
    const industrySet = new Set();
    const taskLines = [];
    const hints = [];
    const techWeights = {};
    const techMap = {}; // canonical -> accumulator
    const daySet = new Set();
    const machineSet = new Set();
    const originSet = new Set();
    for (const s of proj._states) {
      if (!agg.first_seen || s.created_at < agg.first_seen) agg.first_seen = s.created_at;
      if (!agg.last_seen || s.last_event_at > agg.last_seen) agg.last_seen = s.last_event_at;
      for (const t of [s.created_at, s.last_event_at]) if (t) daySet.add(String(t).slice(0, 10));
      if (s.machine_id) machineSet.add(s.machine_id);
      const rawOrigin = normOrigin(s.git_origin);
      if (rawOrigin) originSet.add(rawOrigin);
      const corr = corrections.sessions[s.session_id] || {};
      const cls = effectiveClassification(s, corrections);
      if (!cls) continue;
      agg.classified_sessions++;
      const cat = corr.label && corr.label !== 'ignore' ? corr.label : cls.work_category;
      agg.work_category_votes[cat] = (agg.work_category_votes[cat] || 0) + 1;
      const depth = cls.work_depth || null;
      if (depth in agg.depths) agg.depths[depth]++;
      const via = (cls._meta && cls._meta.classifier) || 'unknown';
      agg.via[via] = (agg.via[via] || 0) + 1;
      for (const ind of cls.industry || []) industrySet.add(ind);
      for (const t of cls.tasks || []) taskLines.push({ text: t, at: s.last_event_at || s.created_at });
      if (cls.project_hint) hints.push(cls.project_hint);
      for (const tech of cls.technologies || []) {
        // Aggregate by canonical name so display-form variants ("C# / .NET",
        // "ASP.NET Core") pool into one capability; compound names contribute
        // to each capability they name. The verified flag survives aggregation
        // (eval finding F1): a project-level hands_on backed by zero tool
        // evidence must stay distinguishable from a corroborated one.
        const keys = tech.canonicals || [tech.canonical || String(tech.name).toLowerCase()];
        for (const k of keys) {
          const cur = techMap[k] || {
            name: tech.name,
            max_evidence: 'mentioned',
            sessions: 0,
            verified_sessions: 0,
            verified_max_evidence: null,
            substantive_sessions: 0,
            first_at: null,
            last_at: null,
            evidence: [],
          };
          cur.sessions++;
          if (EVIDENCE_WEIGHT[tech.evidence] > EVIDENCE_WEIGHT[cur.max_evidence]) {
            cur.max_evidence = tech.evidence;
            cur.name = tech.name; // display name follows the strongest claim
          }
          if (tech.verified) {
            cur.verified_sessions++;
            if (!cur.verified_max_evidence || EVIDENCE_WEIGHT[tech.evidence] > EVIDENCE_WEIGHT[cur.verified_max_evidence]) {
              cur.verified_max_evidence = tech.evidence;
            }
          }
          if (depth === 'substantive') cur.substantive_sessions++;
          if (!cur.first_at || s.created_at < cur.first_at) cur.first_at = s.created_at;
          if (!cur.last_at || s.last_event_at > cur.last_at) cur.last_at = s.last_event_at;
          // The explainability trace: which session claimed this, at what
          // evidence level, and why the pipeline believed it.
          cur.evidence.push({
            session_id: s.session_id,
            evidence: tech.evidence,
            verified: !!tech.verified,
            basis: tech.basis || [],
            at: s.last_event_at || s.created_at,
            depth,
            via,
            category: cat,
          });
          techMap[k] = cur;
          const w = EVIDENCE_WEIGHT[tech.evidence] || 0;
          techWeights[k] = Math.max(techWeights[k] || 0, w);
        }
      }
    }
    agg.industries = [...industrySet];
    // "Recent work": the newest task lines with their session dates. Replaces
    // the old top-by-frequency list — free-text task phrases essentially never
    // repeat verbatim, so frequency ranking degenerated to ten random phrases.
    agg.tasks_recent = taskLines.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-10);
    agg.active_days = daySet.size;
    agg.machine_ids = [...machineSet];
    agg.technologies = Object.entries(techMap)
      .map(([canonical, t]) => ({
        canonical,
        ...t,
        // Counts stay exact regardless of the cap; the trace keeps the most
        // defensible rows (verified first, then most recent).
        evidence: t.evidence
          .sort((x, y) => (y.verified === x.verified ? String(y.at).localeCompare(String(x.at)) : y.verified ? 1 : -1))
          .slice(0, EVIDENCE_ROWS_CAP),
      }))
      .sort(
        (a, b) =>
          EVIDENCE_WEIGHT[b.max_evidence] - EVIDENCE_WEIGHT[a.max_evidence] ||
          b.verified_sessions - a.verified_sessions ||
          b.sessions - a.sessions ||
          (a.canonical < b.canonical ? -1 : 1)
      );
    proj.aggregate = agg;
    proj._hints = hints;
    proj._techWeights = techWeights;
    proj._origins = originSet;

    // Names: declared engagement name outranks a local rename; path-derived
    // basenames never apply to manual/singleton/engagement keys.
    const nameCorr = corrections.projects[proj.id];
    proj.name =
      (proj._engagement && proj._engagement.name) ||
      (nameCorr && nameCorr.name) ||
      (['manual', 'session', 'engagement'].includes(proj.key.kind) || proj.key.value === 'unknown'
        ? null
        : basename(proj.key.value)) ||
      (hints[0] || proj.id);
  }

  // Pass 2: merge suggestions.
  const list = [...projects.values()];
  const dismissed = new Set(
    (corrections.dismissed_merges || []).map((pair) => [...pair].sort().join('|'))
  );
  for (const p of list) p.suggested_merges = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (dismissed.has([a.id, b.id].sort().join('|'))) continue;
      const { score, reasons } = similarity(a, b, basename);
      if (score >= 0.5) {
        const [small, big] = a.aggregate.total_sessions <= b.aggregate.total_sessions ? [a, b] : [b, a];
        small.suggested_merges.push({ project_id: big.id, project_name: big.name, score: Math.round(score * 100) / 100, reasons });
      }
    }
  }

  return {
    projects: list
      .map((p) => ({
        id: p.id,
        name: p.name,
        key: p.key,
        engagement_id: p.engagement_id || null,
        engagement_kind: p.engagement_kind || null,
        singleton: p.key.kind === 'session',
        session_ids: p.session_ids,
        membership: p.membership,
        origins: [...p._origins],
        aggregate: p.aggregate,
        suggested_merges: p.suggested_merges,
      }))
      .sort((a, b) => (a.aggregate.last_seen < b.aggregate.last_seen ? 1 : -1)),
  };
}

function similarity(a, b, basename = crossPlatformBasename) {
  const reasons = [];
  const hintOverlap = jaccard(hintTokens(a._hints), hintTokens(b._hints));
  const techOverlap = weightedTechJaccard(a._techWeights, b._techWeights);
  const industryMatch = a.aggregate.industries.some((x) => b.aggregate.industries.includes(x)) ? 1 : 0;

  // Same remote origin IS the same repo — this signal alone crosses the
  // suggestion threshold (checkout-path mismatches across machines).
  let originMatch = 0;
  for (const o of a._origins) if (b._origins.has(o)) originMatch = 1;

  const pathKinds = new Set(['git_root', 'cwd']);
  const basenameMatch =
    pathKinds.has(a.key.kind) && pathKinds.has(b.key.kind) && basename(a.key.value) === basename(b.key.value) ? 1 : 0;

  let temporal = 0;
  const aLast = new Date(a.aggregate.last_seen || 0).getTime();
  const bFirst = new Date(b.aggregate.first_seen || 0).getTime();
  const bLast = new Date(b.aggregate.last_seen || 0).getTime();
  const aFirst = new Date(a.aggregate.first_seen || 0).getTime();
  const gapMs = Math.max(0, Math.max(aFirst, bFirst) - Math.min(aLast, bLast));
  const gapHours = gapMs / 3600000;
  temporal = Math.exp(-gapHours / 24);

  let continuation = 0;
  if (hintOverlap > 0) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const xLast = new Date(x.aggregate.last_seen || 0).getTime();
      for (const s of y._states) {
        const cls = s.classification;
        if (cls && cls.continuation && new Date(s.created_at).getTime() - xLast < 48 * 3600000 && new Date(s.created_at).getTime() > xLast) {
          continuation = 1;
        }
      }
    }
  }

  const parts = [
    ['same_origin', 0.6 * originMatch],
    ['same_basename', 0.2 * basenameMatch],
    ['hint_overlap', 0.35 * hintOverlap],
    ['tech_overlap', 0.25 * techOverlap],
    ['industry_match', 0.1 * industryMatch],
    ['temporal_proximity', 0.15 * temporal],
    ['continuation', 0.15 * continuation],
  ];
  let score = 0;
  for (const [name, v] of parts) {
    score += v;
    if (v > 0.1) reasons.push(name);
  }
  return { score, reasons };
}

module.exports = {
  EMPTY_CORRECTIONS,
  EVIDENCE_WEIGHT,
  WINDOWS_PATH_OPTS,
  SLASH_PATH_OPTS,
  groupSessions,
  effectiveClassification,
  resolveMerged,
  projectIdOf,
  normOrigin,
};
