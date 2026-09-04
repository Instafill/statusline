'use strict';
// The whole chain the dashboard reports on: spool, fold, digest, classifier
// call, stored classification. Runs against launchd's PATH with the CLI only
// reachable through the install-directory fallback, so a regression in
// resolution shows up as the heuristic fallback rather than as a green test.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-e2e-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { ensureDirs } = require('../src/paths');
const sessions = require('../src/watcher/sessions');
const spool = require('../src/watcher/spool');
const { classifySessionNow } = require('../src/classify/run');
const { tempHome, writeFallbackCli, underLaunchdPath } = require('./helpers/launchd');

ensureDirs();

const SPOOL_NEW = path.join(TESTHOME, 'spool', 'new');
const SID = 'e2e-aaaa-bbbb';
const T0 = 1_755_000_000_000;

// `validate` in src/classify/schema.js treats only professional_work and
// confidence as fatal. Everything else coerces to a default, so this fixture
// carries the least that still passes.
const CLASSIFICATION = {
  professional_work: true,
  confidence: 0.8,
  work_category: 'internal_work',
  work_type: 'software development',
  work_stage: 'implementation',
  work_depth: 'substantive',
  technologies: [{ name: 'JavaScript', evidence: 'hands_on' }],
};

let seq = 0;

/**
 * @param {Record<string, unknown>} payload a hook event as hook-forward writes it
 * @param {number} tsMs
 */
function spoolEvent(payload, tsMs) {
  const name = `${tsMs}-1234-ev${String(seq++).padStart(4, '0')}.json`;
  fs.writeFileSync(path.join(SPOOL_NEW, name), JSON.stringify(payload));
}

/** Drives one finished session through the spool and into folded state. */
function seedSession() {
  const base = {
    session_id: SID,
    transcript_path: null,
    cwd: path.join(TESTHOME, 'work', 'app'),
    permission_mode: 'default',
  };

  spoolEvent({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, T0);
  spoolEvent({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add retries' }, T0 + 1_000);
  spoolEvent(
    {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    },
    T0 + 2_000
  );
  spoolEvent({ ...base, hook_event_name: 'Stop', stop_hook_active: false }, T0 + 3_000);
  spool.drainOnce();
}

test(
  'a session classifies for real when the CLI is only in an install directory',
  { skip: process.platform === 'win32' },
  async () => {
    const home = tempHome();
    const envelope = JSON.stringify({ is_error: false, result: JSON.stringify(CLASSIFICATION) });

    writeFallbackCli(home, `cat > /dev/null\ncat <<'EOF'\n${envelope}\nEOF`);
    seedSession();

    await underLaunchdPath(home, () => classifySessionNow(SID, { trigger: 'manual' }));
    const state = sessions.getSession(SID);

    assert.strictEqual(state.classification_state, 'classified');
    assert.strictEqual(state.classification._meta.classifier, 'claude-cli');
    assert.strictEqual(state.classification.work_type, 'software development');
    assert.strictEqual(state.classifier_error, null);
  }
);
