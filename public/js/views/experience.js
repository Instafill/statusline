/* Experience — capability history derived from DISTINCT projects (never
   session volume). Local is single-user: one "self" doc over this machine's
   sessions; the machine→person mapping and org rollup live in the team app. */
import { api } from '../core.js';
import { experienceDoc } from '../components.js';

export async function renderExperience(el) {
  const data = await api('/api/experience');
  const docs = data.practitioners || [];
  if (!docs.length) {
    el.innerHTML = '<div class="empty">No experience yet — it appears once sessions are classified into projects.</div>';
    return;
  }
  el.innerHTML = docs.map(experienceDoc).join('');
}
