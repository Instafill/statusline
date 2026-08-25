'use strict';
// Team uploader: pushes full session docs + watcher heartbeats to the cloud
// ingest endpoint. Durable inputs are the session state files plus a per-sid
// sha map of what was last acknowledged (~/.statusline/upload-state.json) —
// the in-memory dirty set is only a latency optimization, and the 60s
// reconcile scan is the correctness mechanism (same philosophy as the spool
// rescan). Every batch attempt, success or failure, is egress-logged.
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('../paths');
const config = require('../config');
const sessions = require('../watcher/sessions');
const egress = require('../classify/egress');
const { liveness, classificationOutlook } = require('../session-view');
const { readJson, writeJsonAtomic } = require('../util/jsonfile');
const { machineIdentity } = require('./identity');
const skills = require('../skill-status');
const { ingestUrl, endpointHost } = require('./endpoints');
const teamConfig = require('../team-config');
const log = require('../util/log');

const RECONCILE_MS = 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const BACKOFF_MIN_MS = 30 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MAX_BATCH_DOCS = 100;
const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const EGRESS_MAX_SIDS = 20; // keep egress.jsonl lines bounded

// Deterministic serialization so the change-detection sha is stable across
// runs regardless of property insertion order.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// Sha over the doc minus the fields that churn without new information:
// updated_at moves on every fold, outlook.due_at slides with the clock,
// uploaded_at is stamped per attempt. `live` stays IN the sha so a
// live->closed flip re-uploads on the next reconcile.
function docSha(doc) {
  const { updated_at, outlook, uploaded_at, ...rest } = doc;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

const { stripContent } = require('./strip');

function createUploader({ getSchedulerStats, startedAt, onTeamConfig }) {
  const dirty = new Set();
  let debounceTimer = null;
  let reconcileTimer = null;
  let heartbeatTimer = null;
  let inflight = null; // shared so concurrent callers await the active flush
  let backoffUntil = 0;
  let consecutiveFailures = 0;

  const loadState = () => {
    const s = readJson(paths.uploadState, null);
    return s && typeof s === 'object' && s.uploaded ? s : { v: 1, uploaded: {} };
  };

  // The user's corrections must reach the team view or it lies: a session
  // labeled `ignore` (or re-categorized) locally has to drop out of cloud
  // projects/experience too. The correction snapshot rides the doc — it is
  // part of the sha, so changing a label re-ships the session on the next
  // reconcile with no extra plumbing.
  const loadCorrections = () => {
    const c = readJson(paths.corrections, null);
    return c && typeof c === 'object' && c.sessions ? c.sessions : {};
  };

  function buildDoc(s, cfg, corrections) {
    const corr = (corrections || {})[s.session_id];
    let doc = {
      ...s,
      correction:
        corr && (corr.label || corr.field_overrides)
          ? { label: corr.label || null, field_overrides: corr.field_overrides || null }
          : null,
      live: liveness(s),
      outlook: classificationOutlook(s, cfg, getSchedulerStats()),
      uploaded_at: new Date().toISOString(),
    };
    // Hard rule since 2026-08-17: content never uploads. Not configurable —
    // the ingest endpoint strips again server-side regardless.
    return stripContent(doc);
  }

  function watcherStats() {
    let spoolPending = 0;
    try {
      spoolPending = fs.readdirSync(paths.spoolNew).length;
    } catch (e) {
      /* ignore */
    }
    return {
      pid: process.pid,
      started_at: startedAt,
      sessions_total: sessions.listSessions().length,
      spool_pending: spoolPending,
    };
  }

  async function post(cfg, sessionDocs) {
    const body = JSON.stringify({
      v: 1,
      machine: machineIdentity(),
      watcher: watcherStats(),
      // Whether the /statusline skill on this machine is the one this client
      // ships. Five flags, no paths — see skill-status.js forUpload().
      skill: skills.forUpload(),
      // Lets the server skip resending normalization tables we already have.
      config_version: teamConfig.currentVersion(),
      sessions: sessionDocs,
    });
    const entry = {
      kind: 'upload',
      endpoint_host: endpointHost(cfg.upload.endpoint),
      session_count: sessionDocs.length,
      session_ids: sessionDocs.slice(0, EGRESS_MAX_SIDS).map((d) => d.session_id),
      bytes: Buffer.byteLength(body),
      attempt: consecutiveFailures + 1,
    };
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(ingestUrl(cfg.upload.endpoint), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cfg.upload.token}`,
          },
          body,
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      entry.http_status = res.status;
      entry.duration_ms = Date.now() - t0;
      entry.outcome = res.ok ? 'ok' : `http_${res.status}`;
      egress.record(entry);
      if (res.ok) await maybeStoreTeamConfig(res);
      return res.ok;
    } catch (e) {
      entry.duration_ms = Date.now() - t0;
      entry.outcome = e.name === 'AbortError' ? 'timeout' : 'network_error';
      entry.error = String(e.message || e).slice(0, 200);
      egress.record(entry);
      return false;
    }
  }

  // The ingest ACK is the ONLY channel that can deliver updated normalization
  // tables (thin client: tables are data, distributed on the connection we
  // already make — no extra network calls, nothing on disabled installs).
  // teamConfig.store re-validates; a malformed payload is dropped, never
  // fails the upload.
  async function maybeStoreTeamConfig(res) {
    try {
      const ack = await res.json();
      if (!ack || typeof ack !== 'object' || !ack.team_config) return;
      const { changed, errors } = teamConfig.store(ack.team_config);
      if (errors.length)
        log.warn(`team config from server partially invalid: ${errors.slice(0, 3).join('; ')}`);
      if (changed) {
        log.info(`team normalization tables updated to v${teamConfig.currentVersion()}`);
        if (onTeamConfig) onTeamConfig();
      }
    } catch (e) {
      /* non-JSON or unreadable ACK body — nothing to apply */
    }
  }

  function onFailure() {
    consecutiveFailures++;
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
    backoffUntil = Date.now() + delay;
    log.warn(
      `upload failed (${consecutiveFailures} in a row) — next attempt in ${Math.round(delay / 1000)}s`
    );
  }

  function flush() {
    if (inflight) return inflight;
    inflight = doFlush().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function doFlush() {
    if (Date.now() < backoffUntil) return; // reconcile tick retries later
    try {
      const cfg = config.load();
      if (!cfg.upload.enabled || !cfg.upload.endpoint) return;
      const state = loadState();

      // Build docs for dirty sids, dropping the ones whose sha is already
      // acknowledged (fold ran but nothing upload-relevant changed).
      const corrections = loadCorrections();
      const batch = [];
      const shas = new Map();
      let batchBytes = 0;
      for (const sid of [...dirty]) {
        const s = sessions.getSession(sid);
        if (!s) {
          dirty.delete(sid);
          continue;
        }
        const doc = buildDoc(s, cfg, corrections);
        const sha = docSha(doc);
        if (state.uploaded[sid] && state.uploaded[sid].sha === sha) {
          dirty.delete(sid);
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(doc));
        if (batch.length >= MAX_BATCH_DOCS || batchBytes + size > MAX_BATCH_BYTES) break;
        batch.push(doc);
        shas.set(sid, sha);
        batchBytes += size;
      }
      if (batch.length === 0) return;

      const ok = await post(cfg, batch);
      if (ok) {
        consecutiveFailures = 0;
        backoffUntil = 0;
        // Write-after-ack: a crash before this point re-uploads (idempotent
        // upserts), never loses.
        const fresh = loadState();
        const at = new Date().toISOString();
        for (const [sid, sha] of shas) {
          fresh.uploaded[sid] = { sha, at };
          dirty.delete(sid);
        }
        writeJsonAtomic(paths.uploadState, fresh);
        if (dirty.size > 0) scheduleFlush(); // batch cap left a remainder
      } else {
        onFailure();
      }
    } catch (e) {
      log.error(`upload flush crashed: ${e.message}`);
      onFailure();
    }
  }

  function scheduleFlush() {
    if (debounceTimer) return;
    const cfg = config.load();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, cfg.upload.debounce_ms);
    debounceTimer.unref && debounceTimer.unref();
  }

  function markDirty(sid) {
    dirty.add(sid);
    scheduleFlush();
  }

  // Correctness mechanism: recompute the dirty set from disk. Catches CLI
  // classifications, live->closed flips, anything missed while offline, and
  // acts as the retry timer during backoff.
  function reconcile() {
    try {
      const cfg = config.load();
      if (!cfg.upload.enabled || !cfg.upload.endpoint) return;
      const state = loadState();
      const corrections = loadCorrections();
      for (const s of sessions.listSessions()) {
        const rec = state.uploaded[s.session_id];
        if (!rec) {
          dirty.add(s.session_id);
          continue;
        }
        if (docSha(buildDoc(s, cfg, corrections)) !== rec.sha) dirty.add(s.session_id);
      }
      if (dirty.size > 0) void flush();
    } catch (e) {
      log.error(`upload reconcile failed: ${e.message}`);
    }
  }

  async function heartbeat() {
    if (Date.now() < backoffUntil) return;
    const cfg = config.load();
    if (!cfg.upload.enabled || !cfg.upload.endpoint) return;
    const ok = await post(cfg, []);
    if (ok) {
      consecutiveFailures = 0;
    } else {
      onFailure();
    }
  }

  return {
    markDirty,
    reconcile, // exposed for tests
    flush, // exposed for tests
    heartbeat, // exposed for tests
    start() {
      reconcileTimer = setInterval(reconcile, RECONCILE_MS);
      reconcileTimer.unref && reconcileTimer.unref();
      heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
      heartbeatTimer.unref && heartbeatTimer.unref();
      void heartbeat();
      reconcile();
    },
    stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}

module.exports = { createUploader };
