/* Egress log — everything that left this machine: classifier LLM calls (the
   payload hash ties each to the exact digest text on the session page) and,
   when team upload is enabled, session/heartbeat batch uploads. */
import { api, esc, when, tokens, cost } from '../core.js';
import { metaGrid } from '../components.js';

function tokenCell(e) {
  if (e.input_tokens == null && e.output_tokens == null) return '<span class="dim">—</span>';
  return `${tokens(e.input_tokens)} in<br><span class="dim small">${tokens(e.output_tokens)} out</span>`;
}

// Upload rows are batch-level: no single session, no model, no digest.
function sessionCell(e) {
  if (e.session_id) {
    return `<a href="/session/${esc(e.session_id)}"><code>${esc(String(e.session_id).slice(0, 8))}</code></a>`;
  }
  if (e.kind === 'upload') {
    return e.session_count > 0
      ? `${e.session_count} session${e.session_count === 1 ? '' : 's'}`
      : '<span class="dim">heartbeat</span>';
  }
  return '<span class="dim">—</span>';
}

function channelCell(e) {
  if (e.kind === 'upload') return `upload → ${esc(e.endpoint_host || '?')}`;
  const model = e.actual_model
    ? `<br><span class="dim small" title="model reported by the API for this call">${esc(e.actual_model)}</span>`
    : '';
  return `${esc(e.kind)} / ${esc(e.model)}${model}`;
}

function payloadCell(e) {
  if (e.digest_chars != null) {
    return `${e.digest_chars} chars<br><span class="dim small"><code>${esc(String(e.digest_sha256 || '').slice(0, 12))}…</code></span>`;
  }
  if (e.bytes != null) return `${tokens(e.bytes)}B`;
  return '<span class="dim">—</span>';
}

function row(e) {
  return `<tr>
      <td>${when(e.at)}</td>
      <td>${sessionCell(e)}</td>
      <td>${channelCell(e)}</td>
      <td>${payloadCell(e)}</td>
      <td>${tokenCell(e)}</td>
      <td>${cost(e.cost_usd)}</td>
      <td><span class="badge ${e.outcome === 'ok' ? 'text-bg-success' : 'text-bg-danger'}">${esc(e.outcome)}</span></td>
      <td>${((e.duration_ms || 0) / 1000).toFixed(1)}s · try ${e.attempt}</td>
    </tr>`;
}

// Totals cover only the calls that carry cost/token data — entries recorded
// before those fields existed would otherwise understate the real total
// without saying so. Uploads never carry cost and are counted separately.
function totals(list) {
  const llm = list.filter((e) => e.kind !== 'upload');
  const uploads = list.length - llm.length;
  const priced = llm.filter((e) => typeof e.cost_usd === 'number');
  const unpriced = llm.length - priced.length;
  const sum = (field) => llm.reduce((a, e) => a + (e[field] || 0), 0);
  return metaGrid([
    ['LLM calls', String(llm.length)],
    uploads ? ['Uploads', String(uploads)] : null,
    [
      'Total cost',
      cost(priced.reduce((a, e) => a + e.cost_usd, 0)) +
        (unpriced
          ? `<span class="dim small"> · ${unpriced} older call${unpriced === 1 ? '' : 's'} without cost data</span>`
          : ''),
    ],
    ['Tokens in', tokens(sum('input_tokens'))],
    ['Tokens out', tokens(sum('output_tokens'))],
  ]);
}

export async function renderEgress(el) {
  const list = await api('/api/egress');
  if (!list.length) {
    el.innerHTML = '<div class="empty">Nothing has left this machine yet.</div>';
    return;
  }
  el.innerHTML = `<div class="card">
      <h2>Egress log <span class="hint">every LLM call and team upload that left this machine; the sha links to
        the exact digest text on the session page</span></h2>
      ${totals(list)}
      <table class="table table-hover align-top">
        <thead><tr>
          <th>When</th><th>Session</th><th>Channel</th><th>Payload</th>
          <th>Tokens</th><th>Cost</th><th>Outcome</th><th>Duration</th>
        </tr></thead>
        <tbody>${list.map(row).join('')}</tbody>
      </table>
    </div>`;
}
