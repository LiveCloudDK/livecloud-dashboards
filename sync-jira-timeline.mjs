#!/usr/bin/env node
/**
 * sync-jira-timeline.mjs
 *
 * Fetches epics and issues from Jira LCAP project and generates
 * a data.json file compatible with timeline.html's task format.
 *
 * Required env vars:
 *   JIRA_BASE_URL  - e.g. https://u-ii-u.atlassian.net
 *   JIRA_EMAIL     - Atlassian account email
 *   JIRA_API_TOKEN - Atlassian API token
 *
 * Usage: node sync-jira-timeline.mjs
 * Output: data.json (written to current directory)
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://u-ii-u.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN env vars');
  process.exit(1);
}

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

// -- Timeline column config --
const PERIOD_STARTS = [
  new Date('2026-03-16'),
  new Date('2026-04-01'),
  new Date('2026-04-16'),
  new Date('2026-05-01'),
  new Date('2026-05-16'),
  new Date('2026-06-01'),
  new Date('2026-06-16'),
  new Date('2026-07-01'),
  new Date('2026-07-16'),
  new Date('2026-08-01'),
  new Date('2026-08-16'),
  new Date('2026-09-01'),
  new Date('2026-09-16'),
  new Date('2026-10-01'),
  new Date('2026-10-16'),
  new Date('2026-11-01'),
  new Date('2026-11-16'),
  new Date('2026-12-01'),
];
const PERIOD_END = new Date('2026-12-16');

const COLUMNS = [
  'Mar H2','Apr H1','Apr H2','Maj H1','Maj H2','Jun H1','Jun H2',
  'Jul H1','Jul H2','Aug H1','Aug H2','Sep H1','Sep H2',
  'Okt H1','Okt H2','Nov H1','Nov H2','Dec H1'
];

// -- Workstream mapping --
const LABEL_TO_WS = {
  'onboarding':'1','pos':'2','app':'3','fms':'4','commerce':'4',
  'b2b':'5','webshop':'6','operations':'7','pos-integration':'8',
  'infrastructure':'9','festival-ops':'10',
};

const WS_NAMES = {
  '1':'Onboarding','2':'POS','3':'App','4':'Backend/FMS','5':'B2B',
  '6':'Webshop','7':'Personal','8':'POS API','9':'NFC/Wallet','10':'Gates','all':'Alle'
};

// -- Phase mapping --
const LABEL_TO_PHASE = {
  'phase-build':'build','phase-test':'test','phase-live':'live',
  'phase-scale':'scale','phase-polish':'polish','phase-critical':'critical',
  'phase-meeting':'meeting',
};

const STATUS_TO_PHASE = {
  'Backlog':'build','Selected for Development':'build','In Progress':'build',
  'Ready for testing':'test','Ready for test':'test','Done':'live',
  'Closed':'live','Ready for release':'test',
};

// -- Person mapping --
const PERSON_MAP = {
  'jakob':'jakob','tony':'tony','michael':'michael',
  'mikkel':'mikkel','edwin':'edwin','simon':'simon',
};

function normalizePerson(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  for (const [key, val] of Object.entries(PERSON_MAP)) {
    if (lower.includes(key)) return val;
  }
  return lower.split(' ')[0].toLowerCase();
}

// -- Date to period mapping --
function dateToPeriod(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  if (d < PERIOD_STARTS[0]) return 0;
  if (d >= PERIOD_END) return PERIOD_STARTS.length - 1;
  for (let i = PERIOD_STARTS.length - 1; i >= 0; i--) {
    if (d >= PERIOD_STARTS[i]) return i;
  }
  return 0;
}

function computeSpan(startDate, endDate) {
  const s = dateToPeriod(startDate);
  const e = dateToPeriod(endDate);
  if (s === null || e === null) return 1;
  return Math.max(1, e - s + 1);
}

// -- Jira API helpers --
async function jiraPost(path, body) {
  const url = `${JIRA_BASE}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${AUTH}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Jira API ${resp.status} for ${path} - ${text}`);
  }
  return resp.json();
}

async function fetchAllIssues() {
  const jql = 'project = LCAP AND issuetype = Epic AND status not in (Closed) ORDER BY rank ASC';
  const fields = [
    'summary','status','assignee','labels','priority','issuetype',
    'customfield_10015','customfield_10022','customfield_10023',
    'duedate','issuelinks'
  ];

  let allIssues = [];
  let startAt = 0;
  const maxResults = 100;

  while (true) {
    const data = await jiraPost('/rest/api/3/search/jql', {
      jql, fields, maxResults, startAt,
    });
    allIssues = allIssues.concat(data.issues);
    if (startAt + data.issues.length >= data.total) break;
    startAt += maxResults;
  }

  console.log(`Fetched ${allIssues.length} epics from Jira`);
  return allIssues;
}

// -- Transform Jira issue to timeline task --
function issueToTask(issue) {
  const f = issue.fields;
  let ws = '3';
  for (const label of (f.labels || [])) {
    const mapped = LABEL_TO_WS[label.toLowerCase()];
    if (mapped) { ws = mapped; break; }
  }
  let phase = 'build';
  for (const label of (f.labels || [])) {
    const mapped = LABEL_TO_PHASE[label.toLowerCase()];
    if (mapped) { phase = mapped; break; }
  }
  if (phase === 'build' && f.status) {
    const statusPhase = STATUS_TO_PHASE[f.status.name];
    if (statusPhase) phase = statusPhase;
  }
  const persons = [];
  if (f.assignee) {
    const p = normalizePerson(f.assignee.displayName);
    if (p) persons.push(p);
  }
  const startDate = f.customfield_10022 || f.customfield_10015 || null;
  const endDate = f.customfield_10023 || f.duedate || null;
  const start = dateToPeriod(startDate);
  const span = (startDate && endDate) ? computeSpan(startDate, endDate) : 1;
  const deps = [];
  for (const link of (f.issuelinks || [])) {
    if (link.type.name === 'Blocks' && link.inwardIssue) {
      deps.push(link.inwardIssue.key);
    }
  }
  return {
    id: issue.key, label: f.summary, ws, persons,
    start: start !== null ? start : 0, span, phase,
    jira: issue.key, deps,
  };
}

// -- Main --
async function main() {
  console.log('Syncing Jira LCAP -> data.json ...');
  const issues = await fetchAllIssues();
  const tasks = issues.map(issueToTask).filter(t => t.start !== null);
  const output = {
    generated: new Date().toISOString(),
    columns: COLUMNS,
    wsNames: WS_NAMES,
    tasks,
  };
  const fs = await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Written data.json with ${tasks.length} tasks`);
  console.log(`Workstreams: ${[...new Set(tasks.map(t => t.ws))].sort().map(w => WS_NAMES[w] || w).join(', ')}`);
  console.log(`Phases: ${[...new Set(tasks.map(t => t.phase))].sort().join(', ')}`);
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
