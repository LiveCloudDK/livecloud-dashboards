#!/usr/bin/env node
/**
 * sync-jira-timeline.mjs
 * Fetches epics from Jira LCAP project and generates data.json for timeline.html
 *
 * Required env vars:
 *   JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://u-ii-u.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;

if (!JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN env vars');
  process.exit(1);
}

const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

const PERIOD_STARTS = [
  new Date('2026-03-16'), new Date('2026-04-01'), new Date('2026-04-16'),
  new Date('2026-05-01'), new Date('2026-05-16'), new Date('2026-06-01'),
  new Date('2026-06-16'), new Date('2026-07-01'), new Date('2026-07-16'),
  new Date('2026-08-01'), new Date('2026-08-16'), new Date('2026-09-01'),
  new Date('2026-09-16'), new Date('2026-10-01'), new Date('2026-10-16'),
  new Date('2026-11-01'), new Date('2026-11-16'), new Date('2026-12-01'),
];
const PERIOD_END = new Date('2026-12-16');

const COLUMNS = [
  'Mar H2','Apr H1','Apr H2','Maj H1','Maj H2','Jun H1','Jun H2',
  'Jul H1','Jul H2','Aug H1','Aug H2','Sep H1','Sep H2',
  'Okt H1','Okt H2','Nov H1','Nov H2','Dec H1'
];

const LABEL_TO_WS = {
  'onboarding':'1','pos':'2','app':'3','fms':'4','commerce':'4',
  'b2b':'5','webshop':'6','operations':'7','pos-integration':'8',
  'infrastructure':'9','festival-ops':'10',
};
const WS_NAMES = {
  '1':'Onboarding','2':'POS','3':'App','4':'Backend/FMS','5':'B2B',
  '6':'Webshop','7':'Personal','8':'POS API','9':'NFC/Wallet','10':'Gates','all':'Alle'
};
const LABEL_TO_PHASE = {
  'phase-build':'build','phase-test':'test','phase-live':'live',
  'phase-scale':'scale','phase-polish':'polish','phase-critical':'critical','phase-meeting':'meeting',
};
const STATUS_TO_PHASE = {
  'Backlog':'build','Selected for Development':'build','In Progress':'build',
  'Ready for testing':'test','Ready for test':'test','Done':'live','Closed':'live','Ready for release':'test',
};
const PERSON_MAP = { 'jakob':'jakob','tony':'tony','michael':'michael','mikkel':'mikkel','edwin':'edwin','simon':'simon' };

function normalizePerson(name) {
  if (!name) return null;
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(PERSON_MAP)) { if (l.includes(k)) return v; }
  return l.split(' ')[0].toLowerCase();
}

function dateToPeriod(ds) {
  if (!ds) return null;
  const d = new Date(ds);
  if (isNaN(d)) return null;
  if (d < PERIOD_STARTS[0]) return 0;
  if (d >= PERIOD_END) return PERIOD_STARTS.length - 1;
  for (let i = PERIOD_STARTS.length - 1; i >= 0; i--) { if (d >= PERIOD_STARTS[i]) return i; }
  return 0;
}

async function jiraFetch(path) {
  const r = await fetch(JIRA_BASE + path, { headers: { 'Authorization': 'Basic ' + AUTH, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Jira API ' + r.status + ' for ' + path);
  return r.json();
}

async function fetchAllIssues() {
  const jql = encodeURIComponent('project = LCAP AND issuetype = Epic AND status not in (Closed) ORDER BY rank ASC');
  const fields = 'summary,status,assignee,labels,priority,issuetype,customfield_10015,customfield_10022,customfield_10023,duedate,issuelinks';
  let all = [], startAt = 0;
  while (true) {
    const d = await jiraFetch('/rest/api/3/search?jql=' + jql + '&fields=' + fields + '&maxResults=100&startAt=' + startAt);
    all = all.concat(d.issues);
    if (startAt + d.issues.length >= d.total) break;
    startAt += 100;
  }
  console.log('Fetched ' + all.length + ' epics from Jira');
  return all;
}

function issueToTask(issue) {
  const f = issue.fields;
  let ws = '3';
  for (const l of (f.labels || [])) { const m = LABEL_TO_WS[l.toLowerCase()]; if (m) { ws = m; break; } }
  let phase = 'build';
  for (const l of (f.labels || [])) { const m = LABEL_TO_PHASE[l.toLowerCase()]; if (m) { phase = m; break; } }
  if (phase === 'build' && f.status) { const sp = STATUS_TO_PHASE[f.status.name]; if (sp) phase = sp; }
  const persons = [];
  if (f.assignee) { const p = normalizePerson(f.assignee.displayName); if (p) persons.push(p); }
  const startDate = f.customfield_10022 || f.customfield_10015 || null;
  const endDate = f.customfield_10023 || f.duedate || null;
  const start = dateToPeriod(startDate);
  const s = dateToPeriod(startDate), e = dateToPeriod(endDate);
  const span = (s !== null && e !== null) ? Math.max(1, e - s + 1) : 1;
  const deps = [];
  for (const link of (f.issuelinks || [])) { if (link.type.name === 'Blocks' && link.inwardIssue) deps.push(link.inwardIssue.key); }
  return { id: issue.key, label: f.summary, ws, persons, start: start !== null ? start : 0, span, phase, jira: issue.key, deps };
}

async function main() {
  console.log('Syncing Jira LCAP -> data.json ...');
  const issues = await fetchAllIssues();
  const tasks = issues.map(issueToTask).filter(t => t.start !== null);
  const output = { generated: new Date().toISOString(), columns: COLUMNS, wsNames: WS_NAMES, tasks };
  const fs = await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log('Written data.json with ' + tasks.length + ' tasks');
}

main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
