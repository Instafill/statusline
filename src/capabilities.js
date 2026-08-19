'use strict';
// Business-capability catalog — tables as data, mechanics as code, exactly
// like src/tech-normalize.js. The catalog is the closed vocabulary the
// classifier picks `business_capabilities` ids from; entries here are the
// repo defaults and a server-distributed team overlay (src/team-config.js)
// can add/override entries and alias retired ids to successors.
//
// The raw-twin contract (mirrors technologies_raw): the classifier's picks
// are stored untouched in `business_capabilities_raw`; the displayed
// `business_capabilities` is DERIVED from raw on every fold via resolveId(),
// so a catalog rename/merge/addition corrects all history with zero
// classifier calls — including ids the model picked before they existed.
//
// PUBLIC REPO RULE: entries here must be generic disciplines a stranger's
// install could use. Nothing org-, client- or product-specific may appear;
// that belongs in the team overlay. Naming altitude: a proposal line item
// ("Lead data sourcing & enrichment"), never a task ("scraped a registry")
// and never a re-worded technology ("Elasticsearch engineering").
// `domain` is display-only grouping metadata — never part of identity.

const ID_RE = /^[a-z0-9-]{2,48}$/;

const DEFAULTS = {
  version: 0, // 0 = built-in defaults only; the team overlay's version wins
  catalog: {
    // Growth & demand generation
    'outbound-campaign-operations': {
      name: 'Outbound lead generation & campaign operations',
      gloss: 'Cold and campaign email operations: list building, sequencing, campaign setup, deliverability and send-rate management.',
      domain: 'Growth & demand generation',
    },
    'lead-data-sourcing': {
      name: 'Lead data sourcing & enrichment',
      gloss: 'Sourcing, scraping, deduplicating, scoring and enriching prospect and company lists from registries, maps and databases.',
      domain: 'Growth & demand generation',
    },
    'seo-diagnostics': {
      name: 'SEO diagnostics & remediation',
      gloss: 'Diagnosing indexing, ranking and organic-traffic problems; technical SEO fixes to robots, sitemaps, canonicals and redirects.',
      domain: 'Growth & demand generation',
    },
    'paid-search-campaigns': {
      name: 'Paid search campaign management',
      gloss: 'Building and operating paid search advertising: campaign structure, ads, keywords, negatives, extensions and query analysis.',
      domain: 'Growth & demand generation',
    },
    // Revenue & billing operations
    'pricing-unit-economics': {
      name: 'Pricing & unit-economics analysis',
      gloss: 'Analyzing usage, costs, margins and pricing tiers from production data to drive pricing and packaging decisions.',
      domain: 'Revenue & billing operations',
    },
    'billing-systems': {
      name: 'Billing & subscription systems engineering',
      gloss: 'Building and debugging payment, subscription and billing flows, including provider webhooks and fulfillment.',
      domain: 'Revenue & billing operations',
    },
    // AI & data engineering
    'llm-product-engineering': {
      name: 'LLM & AI product engineering',
      gloss: 'Building product features on large language models: prompts, classification, generation pipelines and model integrations.',
      domain: 'AI & data engineering',
    },
    'data-pipeline-engineering': {
      name: 'Data & search pipeline engineering',
      gloss: 'Building ingestion, transformation, migration and search indexing flows that move data between systems.',
      domain: 'AI & data engineering',
    },
    // Business operations
    'process-automation': {
      name: 'Business process analysis & automation',
      gloss: 'Analyzing, redesigning and automating business workflows and operational processes.',
      domain: 'Business operations',
    },
    // Platform & operations
    'developer-tooling': {
      name: 'Developer tooling & internal products',
      gloss: 'Building developer-facing tools and internal products: CLIs, hooks, dashboards, installers and distribution.',
      domain: 'Platform & operations',
    },
    'cloud-operations': {
      name: 'Cloud deployment & operations',
      gloss: 'Deploying and operating cloud applications: releases, configuration, monitoring, incident response and infrastructure debugging.',
      domain: 'Platform & operations',
    },
  },
  // retired-or-alternate id -> current id. Rename = edit `name` in place;
  // merge/retire = alias the old id to its successor. One mechanism, same as
  // tech aliases — an aliased id never renders into the classifier prompt.
  cap_aliases: {},
};

// Section-level merge, same shape as tech-normalize.mergeTables: overlay
// entries win, defaults survive for ids the overlay doesn't mention.
function mergeCatalog(defaults, overlay) {
  if (!overlay) return defaults;
  const out = { ...defaults, version: overlay.version !== undefined ? overlay.version : defaults.version };
  if (overlay.capabilities) out.catalog = { ...defaults.catalog, ...overlay.capabilities };
  if (overlay.cap_aliases) out.cap_aliases = { ...defaults.cap_aliases, ...overlay.cap_aliases };
  return out;
}

// Chase aliases to the current id; null when the id (after aliasing) is not
// in the catalog. Cycle-guarded — a bad alias table degrades to null, never
// hangs a fold.
function resolveId(tables, id) {
  let cur = String(id || '').toLowerCase();
  for (let hops = 0; hops < 5 && tables.cap_aliases[cur]; hops++) cur = tables.cap_aliases[cur];
  return tables.catalog[cur] ? cur : null;
}

// Entries the classifier may pick from, sorted by id for prompt stability.
// Ids that are alias KEYS (retired) are excluded even if a stale overlay
// left them in the catalog too.
function activeEntries(tables) {
  return Object.entries(tables.catalog)
    .filter(([id]) => !tables.cap_aliases[id])
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, e]) => ({ id, name: e.name, gloss: e.gloss || '', domain: e.domain || '' }));
}

// Display metadata for one (already-resolved) id.
function entryOf(tables, id) {
  const e = tables.catalog[id];
  return e ? { id, name: e.name, domain: e.domain || '' } : null;
}

module.exports = { DEFAULTS, ID_RE, mergeCatalog, resolveId, activeEntries, entryOf };
