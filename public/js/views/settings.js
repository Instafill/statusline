/* Settings — watcher/installer state, the raw config, and the privacy contract. */
import { api, esc, on } from '../core.js';
import { metaGrid, banner } from '../components.js';
import { render } from '../router.js';

function watcherCard(status) {
  const sched = status.scheduler;
  const queue = `${sched.queued.length} queued${sched.running ? ' · running' : ''}${
    sched.consecutiveAuthErrors ? ` · ${sched.consecutiveAuthErrors} auth errors` : ''
  }`;
  return `<div class="card"><h2>Watcher status</h2>
      ${metaGrid([
        ['Data directory', esc(status.data_dir)],
        ['Sessions on disk', String(status.sessions)],
        ['Spool', `${status.spool.pending} pending · ${status.spool.quarantined} quarantined`],
        ['Classifier queue', queue],
      ])}
    </div>`;
}

function hooksCard(inst) {
  const entries = inst.entries
    .map(
      (e) => `<div>${e.installed ? '✅' : '❌'} ${esc(e.event)}${
        e.matcher ? ` <span class="dim small">[${esc(e.matcher)}]</span>` : ''
      }</div>`
    )
    .join('');
  return `<div class="card"><h2>Hooks <span class="hint">${esc(inst.settingsPath)}</span></h2>
      ${inst.parseError ? banner(esc(inst.parseError), 'error') : ''}
      ${entries}
      <div class="note">Install/uninstall from a terminal:
        <code>node src/cli.js install</code> / <code>uninstall</code></div>
    </div>`;
}

function enrollmentCard(status, cfg) {
  const up = cfg.upload || {};
  if (!up.enabled) {
    return `<div class="card"><h2>Team enrollment</h2>
      <div class="small">Not enrolled — everything stays on this machine (local-only mode).</div>
      <div class="note">To join a team: open your team dashboard → <b>Team → Connect this machine</b>,
        mint an enroll code, and run the printed command here:
        <code>node src/cli.js join &lt;url&gt; &lt;code&gt;</code>. Then restart the watcher.</div>
    </div>`;
  }
  return `<div class="card"><h2>Team enrollment</h2>
      ${metaGrid([
        ['Endpoint', esc(up.endpoint || '—')],
        ['Machine id', `<code>${esc(status.machine_id || '—')}</code>`],
        ['Credential', up.token ? '<span class="ok">stored (write-only — never displayed)</span>' : '<span class="bad">missing — re-enroll</span>'],
        ['Content', 'classification + metadata only — prompt text never uploads (hard rule)'],
      ])}
      <div class="note">Every upload attempt is in the <a href="/egress">Egress log</a>. Health check:
        <code>node src/cli.js doctor</code> · re-enroll with a fresh code: <code>node src/cli.js join &lt;url&gt; &lt;code&gt;</code>
        · leave the team: set <code>upload.enabled</code> to <code>false</code> below.</div>
    </div>`;
}

export async function renderSettings(el) {
  const [status, cfg] = await Promise.all([api('/api/status'), api('/api/config')]);
  el.innerHTML = `
    ${watcherCard(status)}
    ${enrollmentCard(status, cfg)}
    ${hooksCard(status.installer)}
    <div class="card"><h2>Config <span class="hint">${esc(status.data_dir)}\\config.json</span></h2>
      <textarea class="form-control" class="cfg" id="cfgText">${esc(JSON.stringify(cfg, null, 2))}</textarea>
      <div class="controls-row section">
        <button class="btn btn-primary btn-sm" id="cfgSave">Save config</button>
        <span class="dim small">idle_minutes, model, digest caps, port (port change needs restart)</span>
      </div>
    </div>
    <div class="card"><h2>Privacy</h2>
      <div class="small">Everything stays in <code>${esc(status.data_dir)}</code>. The only network egress is the
        classification call through your local <code>claude</code> CLI — each one is listed in the
        <a href="/egress">Egress log</a> with the exact payload hash. Prompts are stored locally with best-effort
        secret masking; file contents and tool outputs are never captured.</div>
    </div>`;

  on('#cfgSave', 'click', async () => {
    let obj;
    try {
      obj = JSON.parse(document.getElementById('cfgText').value);
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
      return;
    }
    await api('/api/config', 'POST', obj);
    alert('Saved.');
    render();
  });
}
