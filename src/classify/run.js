'use strict';
// Orchestrates one classification: refresh excerpts → build + persist digest
// → classifier → state transition → regroup projects.
const crypto = require('crypto');
const config = require('../config');
const sessions = require('../watcher/sessions');
const { readAssistantExcerpts } = require('../watcher/transcript');
const { buildDigest } = require('../digest');
const classifier = require('./classifier');
const { tryInherit } = require('./inherit');
const log = require('../util/log');

async function classifySessionNow(sid, { trigger = 'manual' } = {}) {
  let state = sessions.foldSession(sid) || sessions.getSession(sid);
  if (!state) throw new Error(`unknown session ${sid}`);
  const cfg = config.load();

  // Continuation inheritance: reuse the project's recent LLM classification
  // for resume/compact/fork sessions instead of spending a classifier call.
  // Manual triggers always run the real classifier.
  if (trigger !== 'manual') {
    const inherited = tryInherit(state, cfg, trigger);
    if (inherited) {
      sessions.updateSession(sid, {
        classification: inherited,
        classification_state: 'classified',
        classified_at: new Date().toISOString(),
        turns_at_classification: state.counts.turns,
        classifier_error: null,
      });
      log.info(
        `session ${sid} inherited classification from ${inherited._meta.inherited_from} (no classifier call)`
      );
      try {
        require('../grouping').recompute();
      } catch (e) {
        log.error(`grouping recompute failed: ${e.message}`);
      }
      return sessions.getSession(sid);
    }
  }

  const excerpts = state.transcript_path
    ? readAssistantExcerpts(state.transcript_path, {
        maxExcerpts: cfg.digest.max_excerpts,
        maxExcerptChars: cfg.digest.max_excerpt_chars,
      })
    : [];
  state = sessions.updateSession(sid, {
    assistant_excerpts: excerpts,
    classification_state: 'pending',
    classifier_error: null,
  });

  const digestText = buildDigest(state, cfg.digest);
  const sha = crypto.createHash('sha256').update(digestText).digest('hex');
  state = sessions.updateSession(sid, {
    digest: {
      text: digestText,
      built_at: new Date().toISOString(),
      chars: digestText.length,
      sha256: sha,
    },
  });

  const res = await classifier.classifySession(state, digestText, { digest_sha256: sha, trigger });

  if (res.ok) {
    sessions.updateSession(sid, {
      classification: res.classification,
      classification_state: 'classified',
      classified_at: new Date().toISOString(),
      turns_at_classification: state.counts.turns,
      // A degraded (heuristic) result keeps the underlying failure visible so
      // the UI and the scheduler's auth backoff can still see it.
      classifier_error: res.degraded
        ? `${res.outcome}: ${String(res.error).slice(0, 200)} (heuristic fallback applied)`
        : null,
    });
    log.info(
      `session ${sid} ${res.degraded ? 'heuristic-classified' : 'classified'}: ${res.classification.work_type} (confidence ${res.classification.confidence})`
    );
    try {
      require('../grouping').recompute();
    } catch (e) {
      log.error(`grouping recompute failed: ${e.message}`);
    }
  } else {
    sessions.updateSession(sid, {
      classification_state: 'classification_failed',
      classifier_error: `${res.outcome}: ${res.error}`,
    });
    log.warn(
      `session ${sid} classification failed (${res.outcome}): ${String(res.error).slice(0, 300)}`
    );
  }
  return sessions.getSession(sid);
}

module.exports = { classifySessionNow };
