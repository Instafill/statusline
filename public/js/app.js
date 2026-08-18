/* Entry point: maps hash routes to views and starts the router.
   Views live in js/views/, shared helpers in js/core.js + js/components.js. */
import { registerView, start } from './router.js';
import { renderSessions } from './views/sessions.js';
import { renderSession } from './views/session.js';
import { renderProjects } from './views/projects.js';
import { renderExperience } from './views/experience.js';
import { renderEgress } from './views/egress.js';
import { renderSettings } from './views/settings.js';

// autoRefresh: list views poll; the session detail view does not, so that open
// expanders and the digest preview survive.
registerView('sessions', renderSessions, { autoRefresh: true });
registerView('session', renderSession, { navTab: 'sessions' });
registerView('projects', renderProjects, { autoRefresh: true });
registerView('experience', renderExperience);
registerView('egress', renderEgress, { autoRefresh: true });
registerView('settings', renderSettings);

start(document.getElementById('main'));
