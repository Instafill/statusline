'use strict';
// Builds the plain-text session digest — the ONLY content that ever leaves
// the machine (sent to the configured classifier). Deterministic section
// order; progressively tighter caps until the budget is met. Pure function of
// (state, cfg) so it is testable and previewable before any send.
const { maskSecrets } = require('./util/secrets');

const NO_TOOLS_LINE = 'No tool usage — conversation only.';

function fmtCounter(counter, cap = 30) {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
}

function durationOf(state) {
  if (!state.created_at || !state.last_event_at) return 'unknown';
  const ms = new Date(state.last_event_at) - new Date(state.created_at);
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${(min / 60).toFixed(1)} h`;
}

function renderPrompts(prompts, caps, lines) {
  const { maxPrompts, maxPromptChars } = caps;
  let list = prompts;
  let omittedNote = null;
  if (prompts.length > maxPrompts) {
    const head = Math.ceil(maxPrompts / 2);
    const tail = maxPrompts - head;
    const omitted = prompts.slice(head, prompts.length - tail);
    const omittedChars = omitted.reduce((n, p) => n + p.text.length, 0);
    list = [...prompts.slice(0, head), null, ...prompts.slice(prompts.length - tail)];
    omittedNote = `[... ${omitted.length} prompts (${omittedChars} chars) omitted ...]`;
  }
  let i = 0;
  for (const p of list) {
    if (p === null) {
      lines.push(omittedNote);
      continue;
    }
    i++;
    let text = p.text.length > maxPromptChars ? p.text.slice(0, maxPromptChars) + ' [...]' : p.text;
    if (p.omitted_chars > 0) text += ` [+${p.omitted_chars} chars truncated at capture]`;
    lines.push(`[${i}] ${text}`);
  }
}

function render(state, caps) {
  const lines = [];
  const tools = state.tools || {};
  const hasTools = (state.counts && state.counts.tool_uses > 0) || false;

  lines.push('SESSION METADATA');
  lines.push(`- session: ${String(state.session_id).slice(0, 8)}`);
  lines.push(
    `- started: ${state.created_at || 'unknown'}; last activity: ${state.last_event_at || 'unknown'}; duration: ${durationOf(state)}`
  );
  lines.push(
    `- working directory: ${state.primary_cwd || 'unknown'}${state.git_root ? ` (git repo: ${state.git_root}${state.git_worktree ? `, worktree: ${state.git_worktree}` : ''})` : ''}`
  );
  lines.push(
    `- session source: ${(state.sources || []).join(', ') || 'unknown'}; end reason: ${state.end_reason || 'still open'}`
  );
  lines.push(
    `- turns: ${state.counts.turns}; prompts: ${state.counts.prompts}; tool calls: ${state.counts.tool_uses}; subagent activity: ${state.counts.subagent_events > 0 ? 'yes' : 'no'}`
  );

  lines.push('');
  lines.push('USER PROMPTS');
  if ((state.prompts || []).length === 0) lines.push('(none captured)');
  else renderPrompts(state.prompts, caps, lines);

  lines.push('');
  lines.push('ASSISTANT EXCERPTS (best-effort, from local transcript)');
  const excerpts = (state.assistant_excerpts || []).slice(-caps.maxExcerpts);
  if (excerpts.length === 0) lines.push('(transcript unavailable)');
  else
    excerpts.forEach((e, i) =>
      lines.push(`[${i + 1}] ${maskSecrets(e.text.slice(0, caps.maxExcerptChars))}`)
    );

  lines.push('');
  lines.push('TOOL ACTIVITY');
  if (!hasTools) {
    lines.push(NO_TOOLS_LINE);
  } else {
    lines.push(`- tool usage counts: ${fmtCounter(tools.by_name || {})}`);
    const bash = (tools.bash_commands || []).slice(0, caps.maxBashCommands);
    if (bash.length) {
      lines.push(
        `- shell commands (deduped${tools.bash_commands.length > bash.length ? `, first ${bash.length} of ${tools.bash_commands.length}` : ''}):`
      );
      for (const c of bash) lines.push(`    $ ${c.slice(0, 300)}`);
    }
    if (Object.keys(tools.extensions || {}).length)
      lines.push(`- files edited by extension: ${fmtCounter(tools.extensions)}`);
    if (Object.keys(tools.extensions_read || {}).length)
      lines.push(`- files read by extension: ${fmtCounter(tools.extensions_read)}`);
    const files = (tools.files_touched || []).slice(0, caps.maxFiles);
    if (files.length) {
      lines.push(
        `- files (${tools.files_touched.length > files.length ? `first ${files.length} of ${tools.files_touched.length}` : files.length}): ${files.join(', ')}`
      );
    }
    if ((tools.mcp_servers || []).length)
      lines.push(`- MCP servers used: ${tools.mcp_servers.join(', ')}`);
    if ((tools.web?.fetch_domains || []).length)
      lines.push(`- web fetches: ${tools.web.fetch_domains.join(', ')}`);
    if ((tools.web?.search_queries || []).length)
      lines.push(`- web searches: ${tools.web.search_queries.map((q) => `"${q}"`).join('; ')}`);
    if ((tools.dependencies_observed || []).length)
      lines.push(`- dependencies installed/added: ${tools.dependencies_observed.join(', ')}`);
  }

  return lines.join('\n');
}

// Shrink levels applied in the plan's documented order:
// bash list → files list → excerpts → harder prompt truncation → minimal.
function shrinkLevels(d) {
  const base = {
    maxPrompts: d.max_prompts,
    maxPromptChars: d.max_prompt_chars,
    maxBashCommands: d.max_bash_commands,
    maxFiles: d.max_files,
    maxExcerpts: d.max_excerpts,
    maxExcerptChars: d.max_excerpt_chars,
  };
  return [
    base,
    { ...base, maxBashCommands: 10 },
    { ...base, maxBashCommands: 10, maxFiles: 15 },
    { ...base, maxBashCommands: 10, maxFiles: 15, maxExcerpts: 2, maxExcerptChars: 400 },
    {
      ...base,
      maxBashCommands: 10,
      maxFiles: 15,
      maxExcerpts: 2,
      maxExcerptChars: 400,
      maxPrompts: 8,
      maxPromptChars: 400,
    },
    {
      maxPrompts: 2,
      maxPromptChars: 300,
      maxBashCommands: 5,
      maxFiles: 5,
      maxExcerpts: 1,
      maxExcerptChars: 200,
    },
  ];
}

function buildDigest(state, digestCfg) {
  let text = '';
  for (const caps of shrinkLevels(digestCfg)) {
    text = render(state, caps);
    if (text.length <= digestCfg.max_chars) return text;
  }
  return text.slice(0, digestCfg.max_chars); // hard floor
}

module.exports = { buildDigest, NO_TOOLS_LINE };
