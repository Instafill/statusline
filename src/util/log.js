'use strict';
const fs = require('fs');
const { paths } = require('../paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

function setLevel(name) {
  threshold = LEVELS[name] || LEVELS.info;
}

function write(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(paths.logFile, line + '\n');
  } catch (e) {
    // logging must never crash the watcher
  }
}

module.exports = {
  setLevel,
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};
