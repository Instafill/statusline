'use strict';
// Every LLM call leaving the machine is recorded here — this is the privacy
// audit trail surfaced in the UI. The digest text itself lives in session
// state; the sha256 ties the two together.
const { paths } = require('../paths');
const { appendJsonl, readJsonl } = require('../util/jsonfile');

function record(entry) {
  appendJsonl(paths.egress, { at: new Date().toISOString(), ...entry });
}

function list(limit = 200) {
  return readJsonl(paths.egress).slice(-limit).reverse();
}

module.exports = { record, list };
