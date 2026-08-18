'use strict';
// Machine identity for team uploads. Only machine_id is persisted (a random
// UUID generated once, surviving hostname changes); hostname/username/platform
// are read fresh so a renamed machine reports its current name.
const os = require('os');
const crypto = require('crypto');
const { paths } = require('../paths');
const { readJson, writeJsonAtomic } = require('../util/jsonfile');

let cached = null;

function machineIdentity() {
  if (cached) return cached;
  let stored = readJson(paths.machine, null);
  if (!stored || typeof stored.machine_id !== 'string' || !stored.machine_id) {
    stored = { v: 1, machine_id: crypto.randomUUID(), created_at: new Date().toISOString() };
    writeJsonAtomic(paths.machine, stored);
  }
  let username = null;
  try {
    username = os.userInfo().username;
  } catch (e) {
    /* leave null */
  }
  cached = {
    machine_id: stored.machine_id,
    hostname: os.hostname(),
    username,
    platform: process.platform,
    app_version: require('../../package.json').version || null,
  };
  return cached;
}

module.exports = { machineIdentity };
