'use strict';
// Classification trigger state machine. One classification at a time; a
// session is classified when it ends or goes idle — never mid-burst.
const config = require('../config');
const sessions = require('./sessions');
const { classifySessionNow } = require('../classify/run');
const log = require('../util/log');

const ELIGIBLE = new Set(['unclassified', 'stale']);

// onSessionWritten(sid): fired after every classification attempt returns
// (classified, inherited, heuristic, or failed — all funnel through pump).
// Used by the uploader; must never be able to break the pump.
function createScheduler({ onSessionWritten } = {}) {
  const queued = new Set();
  const queue = [];
  let running = false;
  let timer = null;
  let consecutiveAuthErrors = 0;

  const authOk = () => consecutiveAuthErrors < 3;

  function enqueue(sid, trigger) {
    if (queued.has(sid)) return false;
    queued.add(sid);
    queue.push({ sid, trigger });
    void pump();
    return true;
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const { sid, trigger } = queue.shift();
        try {
          const state = await classifySessionNow(sid, { trigger });
          // Order matters: a heuristic fallback stores state 'classified' but
          // keeps the auth failure in classifier_error — it must still count
          // toward the backoff.
          if (/^auth_error/.test(state.classifier_error || '')) {
            consecutiveAuthErrors++;
            if (!authOk()) log.warn('classifier auth failing repeatedly — pausing automatic classification (retry manually from the UI after `claude` login)');
          } else if (state.classification_state === 'classified') {
            consecutiveAuthErrors = 0;
          }
        } catch (e) {
          log.error(`classification of ${sid} crashed: ${e.message}`);
        } finally {
          queued.delete(sid);
          if (onSessionWritten) {
            try {
              onSessionWritten(sid);
            } catch (e) {
              log.error(`onSessionWritten(${sid}) failed: ${e.message}`);
            }
          }
        }
      }
    } finally {
      running = false;
    }
  }

  // Called after spool ingestion for each touched session: accelerates
  // classification when a SessionEnd landed.
  function considerAfterEvent(sid) {
    if (!authOk()) return;
    const s = sessions.getSession(sid);
    if (!s || !ELIGIBLE.has(s.classification_state)) return;
    if (s.end_reason && s.counts.prompts >= 1) enqueue(sid, 'session_end');
  }

  // Minimum spacing between attempts to upgrade a heuristic-fallback
  // classification, so a still-broken classifier isn't retried every tick.
  const UPGRADE_SPACING_MS = 30 * 60 * 1000;

  // Periodic: idle sessions with at least one completed turn. This is the
  // primary path — SessionEnd is unreliable (abandoned sessions, tight hook
  // budget shared with other tools). Also upgrades heuristic-fallback
  // classifications once the classifier is reachable again.
  function tick() {
    if (!authOk()) return;
    const cfg = config.load();
    const idleMs = cfg.idle_minutes * 60 * 1000;
    for (const s of sessions.listSessions()) {
      const heuristic =
        s.classification_state === 'classified' &&
        s.classification && s.classification._meta && s.classification._meta.classifier === 'heuristic';
      if (!ELIGIBLE.has(s.classification_state) && !heuristic) continue;
      if (heuristic && Date.now() - new Date(s.classified_at || 0).getTime() < UPGRADE_SPACING_MS) continue;
      if (s.counts.turns < 1) continue;
      const idle = Date.now() - new Date(s.last_event_at).getTime();
      if (Number.isFinite(idle) && idle >= idleMs) enqueue(s.session_id, heuristic ? 'upgrade' : 'idle');
    }
  }

  return {
    start() {
      timer = setInterval(tick, 60 * 1000);
      if (timer.unref) timer.unref();
      tick();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    considerAfterEvent,
    // Manual trigger (UI/CLI): bypasses eligibility except an in-flight run.
    classifyNow(sid) {
      consecutiveAuthErrors = 0; // user explicitly asked — try again
      return enqueue(sid, 'manual');
    },
    stats() {
      return { queued: [...queued], running, consecutiveAuthErrors };
    },
  };
}

module.exports = { createScheduler };
