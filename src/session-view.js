'use strict';
// Derived per-session view fields computed from local-only facts (process
// liveness, scheduler state). Used by the local API on every request and by
// the uploader to snapshot them into cloud documents at upload time.
const { isAlive } = require('./util/proc');

// true = the owning Claude Code process is still running (terminal tab open),
// false = it exited, null = unknown (session predates host_pid capture).
// A session that reported SessionEnd is never "live" even if the process
// survives — /clear ends a session while the window stays open.
function liveness(s) {
  if (s.end_reason) return false;
  return isAlive(s.host_pid);
}

// What will happen to this session's classification next, computed from the
// same rules the scheduler applies — so the UI can show it instead of leaving
// users guessing. due_at is when the idle trigger becomes eligible (it slides
// forward with every new event).
function classificationOutlook(s, cfg, sched) {
  if (sched.queued.includes(s.session_id)) return { kind: 'queued' };
  if (s.classification_state === 'pending') return { kind: 'pending' };
  if (s.classification_state === 'classification_failed') {
    return { kind: 'failed', auth: /auth_error/.test(s.classifier_error || '') };
  }
  const authPaused = sched.consecutiveAuthErrors >= 3;
  const dueAt = (fromIso, extraMs = 0) =>
    new Date(new Date(fromIso).getTime() + cfg.idle_minutes * 60000 + extraMs).toISOString();

  if (s.classification_state === 'unclassified' || s.classification_state === 'stale') {
    if (s.counts.turns < 1) {
      return s.counts.prompts === 0 && s.counts.tool_uses === 0
        ? { kind: 'never' }
        : { kind: 'waiting_turn' };
    }
    if (authPaused) return { kind: 'paused_auth' };
    return { kind: s.classification_state === 'stale' ? 'recheck' : 'idle', due_at: dueAt(s.last_event_at) };
  }
  const meta = (s.classification && s.classification._meta) || {};
  if (s.classification_state === 'classified' && meta.classifier === 'heuristic') {
    if (authPaused) return { kind: 'paused_auth' };
    // Upgrade needs both the 30-min spacing from classified_at and idleness.
    const spacing = new Date(s.classified_at || 0).getTime() + 30 * 60000;
    const idleDue = new Date(dueAt(s.last_event_at)).getTime();
    return { kind: 'upgrade', due_at: new Date(Math.max(spacing, idleDue)).toISOString() };
  }
  return { kind: 'done' };
}

module.exports = { liveness, classificationOutlook };
