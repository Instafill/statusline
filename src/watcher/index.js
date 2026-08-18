'use strict';
// Watcher main: single-instance lock, spool ingestion loop, classification
// scheduler, retention, HTTP server.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { paths, ensureDirs } = require('../paths');
const config = require('../config');
const { readJson, writeJsonAtomic } = require('../util/jsonfile');
const spool = require('./spool');
const { createScheduler } = require('./scheduler');
const { createApi } = require('../server/api');
const { createServer } = require('../server/http');
const grouping = require('../grouping');
const log = require('../util/log');

function probeHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).app === 'statusline');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function cleanupRetention(cfg) {
  const now = Date.now();
  const pruneDir = (dir, days) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      return;
    }
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        if (now - fs.statSync(f).mtimeMs > days * 86400000) fs.unlinkSync(f);
      } catch (e) {
        /* ignore */
      }
    }
  };
  pruneDir(paths.spoolQuarantine, cfg.spool.quarantine_keep_days);
  pruneDir(paths.spoolTmp, 1); // orphaned temp files from crashed hooks
}

async function start() {
  ensureDirs();
  const cfg = config.load();
  log.setLevel(cfg.log_level);

  // Single instance.
  const lock = readJson(paths.lock, null);
  if (lock && (await probeHealth(lock.port || cfg.port))) {
    console.error(`statusline watcher already running (pid ${lock.pid}, http://127.0.0.1:${lock.port || cfg.port}). Exiting.`);
    process.exit(1);
  }
  writeJsonAtomic(paths.lock, { pid: process.pid, port: cfg.port, started_at: new Date().toISOString() });

  const startedAt = new Date().toISOString();

  // Team uploader: only loaded when configured — a disabled install runs zero
  // upload code and can make zero upload network calls (CLAUDE.md rule 2).
  let uploader = null;
  const scheduler = createScheduler({
    onSessionWritten: (sid) => uploader && uploader.markDirty(sid),
  });
  if (cfg.upload && cfg.upload.enabled && cfg.upload.endpoint) {
    uploader = require('../upload').createUploader({
      getSchedulerStats: () => scheduler.stats(),
      startedAt,
      onTeamConfig: () => rederiveIfTablesChanged(),
    });
  }

  // classification.technologies is derived from raw claims + normalization
  // tables. When the table version changes (server pushed new tables via the
  // ingest ACK, or a fresh install applies the built-ins), re-derive every
  // classified session once — history corrects itself with zero LLM calls,
  // and the uploader's sha check re-uploads exactly what changed.
  function rederiveIfTablesChanged() {
    try {
      const teamConfig = require('../team-config');
      const current = teamConfig.currentVersion();
      if (String(current) === String(teamConfig.appliedVersion())) return;
      const { deriveTechnologies } = require('../evidence');
      const sessionsMod = require('./sessions');
      let updated = 0;
      for (const s of sessionsMod.listSessions()) {
        if (!s.classification) continue;
        deriveTechnologies(s);
        sessionsMod.updateSession(s.session_id, { classification: s.classification });
        if (uploader) uploader.markDirty(s.session_id);
        updated++;
      }
      grouping.recompute();
      teamConfig.markApplied();
      log.info(`normalization tables v${current}: re-derived technologies for ${updated} classified sessions`);
    } catch (e) {
      log.error(`table rederive failed: ${e.message}`);
    }
  }

  const drain = () => {
    try {
      const res = spool.drainOnce();
      if (res.ingested > 0) log.debug(`ingested ${res.ingested} events (${res.sessions.length} sessions)`);
      for (const sid of res.sessions) {
        scheduler.considerAfterEvent(sid);
        if (uploader) uploader.markDirty(sid);
      }
    } catch (e) {
      log.error(`drain failed: ${e.message}`);
    }
  };

  // Crash recovery: a session left 'pending' by a dead watcher would never
  // re-enter the trigger flow — demote it to 'stale' so idle/end triggers
  // pick it up again.
  const sessions = require('./sessions');
  for (const s of sessions.listSessions()) {
    if (s.classification_state === 'pending') {
      sessions.updateSession(s.session_id, { classification_state: 'stale' });
      log.warn(`session ${s.session_id} was stuck pending (watcher died mid-classification); marked stale`);
    }
  }

  // Initial drain catches everything spooled while the watcher was down.
  drain();
  rederiveIfTablesChanged(); // covers table updates received while down + first-run migration
  grouping.recompute();
  scheduler.start();
  if (uploader) uploader.start(); // initial reconcile sweeps anything missed while down

  // fs.watch for latency; periodic rescan is the correctness mechanism
  // (fs.watch on Windows can drop events).
  let debounce = null;
  try {
    fs.watch(paths.spoolNew, () => {
      clearTimeout(debounce);
      debounce = setTimeout(drain, 250);
    });
  } catch (e) {
    log.warn(`fs.watch unavailable (${e.message}); relying on rescan timer`);
  }
  const rescan = setInterval(drain, cfg.spool.rescan_ms);
  rescan.unref && rescan.unref();

  const retention = setInterval(() => cleanupRetention(cfg), 6 * 3600 * 1000);
  retention.unref && retention.unref();
  cleanupRetention(cfg);

  // Rollup for the Claude Code status line. Refreshed on a timer so the status
  // line itself only ever reads one small file.
  const statusSummary = require('../status-summary');
  statusSummary.write(cfg);
  const summaryTimer = setInterval(() => statusSummary.write(cfg), 15000);
  summaryTimer.unref && summaryTimer.unref();

  const routes = createApi({ scheduler, startedAt });
  await createServer(cfg, routes);
  log.info(`statusline watcher running — UI at http://127.0.0.1:${cfg.port} (data: ${paths.home})`);
  console.log(`\n  statusline is watching Claude Code sessions.\n  UI:   http://127.0.0.1:${cfg.port}\n  Data: ${paths.home}\n  Stop: Ctrl+C\n`);

  // A clone that was pulled but never re-installed would silently miss whatever
  // hook events were added since. Surface it once, at the only moment anyone is
  // looking at this output.
  try {
    const drift = require('../installer').status().drift;
    if (drift) {
      log.warn(`install drift: ${drift}`);
      console.log(`  ! Install is out of date: ${drift}.\n    Run "node src/cli.js install" to refresh.\n`);
    }
  } catch (e) {
    log.warn(`could not check install drift: ${e.message}`);
  }

  const shutdown = () => {
    log.info('shutting down');
    try {
      fs.unlinkSync(paths.lock);
    } catch (e) {
      /* ignore */
    }
    // Drop the rollup so the status line reports "off" immediately rather than
    // waiting for the staleness window to expire.
    try {
      fs.unlinkSync(paths.summary);
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { start };
