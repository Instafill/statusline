'use strict';
// Local project grouping: loads session states + corrections.json, runs the
// shared pure algorithm (src/grouping-core.js) with the historical Windows
// path normalization (project ids must stay stable), persists projects.json.
// Pass 1 is deterministic (git root, else cwd). Pass 2 only SUGGESTS merges
// via a similarity score — accepting one is a user action recorded in
// corrections.json, and corrections always win on recompute.
const { paths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./util/jsonfile');
const sessions = require('./watcher/sessions');
const core = require('./grouping-core');

function loadCorrections() {
  const c = readJson(paths.corrections, null);
  return c && typeof c === 'object' ? { ...core.EMPTY_CORRECTIONS, ...c } : { ...core.EMPTY_CORRECTIONS };
}

function saveCorrections(c) {
  writeJsonAtomic(paths.corrections, c);
}

function recompute() {
  const corrections = loadCorrections();
  const grouped = core.groupSessions(sessions.listSessions(), corrections, core.WINDOWS_PATH_OPTS);
  const out = { v: 1, updated_at: new Date().toISOString(), ...grouped };
  writeJsonAtomic(paths.projects, out);
  return out;
}

function getProjects() {
  return readJson(paths.projects, { v: 1, updated_at: null, projects: [] });
}

// ---- correction mutations (each triggers recompute) -----------------------

function setSessionLabel(sid, label) {
  const c = loadCorrections();
  c.sessions[sid] = { ...(c.sessions[sid] || {}), label, updated_at: new Date().toISOString() };
  saveCorrections(c);
  return recompute();
}

function setSessionOverrides(sid, fieldOverrides) {
  const c = loadCorrections();
  c.sessions[sid] = { ...(c.sessions[sid] || {}), field_overrides: fieldOverrides, updated_at: new Date().toISOString() };
  saveCorrections(c);
  return recompute();
}

function setSessionProject(sid, projectId) {
  const c = loadCorrections();
  c.sessions[sid] = { ...(c.sessions[sid] || {}), project_id: projectId || undefined, updated_at: new Date().toISOString() };
  if (!projectId) delete c.sessions[sid].project_id;
  saveCorrections(c);
  return recompute();
}

function renameProject(projectId, name) {
  const c = loadCorrections();
  c.projects[projectId] = { ...(c.projects[projectId] || {}), name, updated_at: new Date().toISOString() };
  saveCorrections(c);
  return recompute();
}

function mergeProjects(fromId, intoId) {
  const c = loadCorrections();
  c.projects[fromId] = { ...(c.projects[fromId] || {}), merged_into: intoId, updated_at: new Date().toISOString() };
  saveCorrections(c);
  return recompute();
}

function dismissMerge(idA, idB) {
  const c = loadCorrections();
  c.dismissed_merges = c.dismissed_merges || [];
  c.dismissed_merges.push([idA, idB]);
  saveCorrections(c);
  return recompute();
}

module.exports = {
  recompute,
  getProjects,
  loadCorrections,
  effectiveClassification: core.effectiveClassification,
  setSessionLabel,
  setSessionOverrides,
  setSessionProject,
  renameProject,
  mergeProjects,
  dismissMerge,
};
