#!/usr/bin/env node
/**
 * sync-jira-timeline.mjs
 * Fetches epics + active sprint from Jira LCAP and generates data.json.
 * Uses POST /rest/api/3/search/jql for epics, GET agile API for sprint.
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://u-ii-u.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
if (!JIRA_EMAIL || !JIRA_TOKEN) { console.error('Missing JIRA_EMAIL or JIRA_API_TOKEN'); process.exit(1); }
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
const COLUMNS = ['Mar H2','Apr H1','Apr H2','Maj H1','Maj H2','Jun H1','Jun H2','Jul H1','Jul H2','Aug H1','Aug H2','Sep H1','Sep H2','Okt H1','Okt H2','Nov H1','Nov H2','Dec H1'];

const LABEL_TO_WS = {'onboarding':'1','pos':'2','app':'3','fms':'4','commerce':'4','b2b':'5','webshop':'6','operations':'7','pos-integration':'8','infrastructure':'9','festival-ops':'10'};
const WS_NAMES = {'1':'Onboarding','2':'POS','3':'App','4':'Backend/FMS','5':'B2B','6':'Webshop','7':'Personal','8':'POS API','9':'NFC/Wallet','10':'Gates','all':'Alle'};
const LABEL_TO_PHASE = {'phase-build':'build','phase-test':'test','phase-live':'live','phase-scale':'scale','phase-polish':'polish','phase-critical':'critical','phase-meeting':'meeting'};
const STATUS_TO_PHASE = {'Backlog':'build','Selected for Development':'build','In Progress':'build','Ready for testing':'test','Ready for test':'test','Done':'live','Closed':'live','Ready for release':'test'};
const PERSON_MAP = {'jakob':'jakob','tony':'tony','michael':'michael','mikkel':'mikkel','edwin':'edwin','simon':'simon'};

function normalizePerson(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [k,v] of Object.entries(PERSON_MAP)) { if (lower.includes(k)) return v; }
  return lower.split(' ')[0].toLowerCase();
}

function dateToPeriod(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  if (d < PERIOD_STARTS[0]) return 0;
  if (d >= PERIOD_END) return PERIOD_STARTS.length - 1;
  for (let i = PERIOD_STARTS.length - 1; i >= 0; i--) { if (d >= PERIOD_STARTS[i]) return i; }
  return 0;
}

function computeSpan(s, e) {
  const sp = dateToPeriod(s), ep = dateToPeriod(e);
  if (sp === null || ep === null) return 1;
  return Math.max(1, ep - sp + 1);
}

async function jiraGet(path) {
  const resp = await fetch(`${JIRA_BASE}${path}`, { headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json' } });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Jira API ${resp.status} for ${path} - ${t}`); }
  return resp.json();
}

async function jiraPost(path, body) {
  const resp = await fetch(`${JIRA_BASE}${path}`, { method:'POST', headers: { 'Authorization': `Basic ${AUTH}`, 'Accept':'application/json', 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`Jira API ${resp.status} for ${path} - ${t}`); }
  return resp.json();
}

async function fetchAllEpics() {
  const jql = 'project = LCAP AND issuetype = Epic AND status not in (Closed) ORDER BY rank ASC';
  const fields = ['summary','status','assignee','labels','priority','issuetype','customfield_10015','customfield_10022','customfield_10023','duedate','issuelinks'];
  let all = [], nextPageToken = null;
  while (true) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await jiraPost('/rest/api/3/search/jql', body);
    all = all.concat(data.issues || []);
    if (data.nextPageToken) { nextPageToken = data.nextPageToken; } else break;
  }
  console.log(`Fetched ${all.length} epics`);
  return all;
}

async function fetchActiveSprint() {
  try {
    const data = await jiraGet('/rest/agile/1.0/board/136/sprint?state=active');
    return (data.values && data.values.length > 0) ? data.values[0] : null;
  } catch (err) { console.warn('No active sprint:', err.message); return null; }
}

async function fetchSprintIssues(sprintId) {
  try {
    const data = await jiraGet(`/rest/agile/1.0/board/136/sprint/${sprintId}/issue?maxResults=200&fields=summary,status,assignee,priority,labels,issuetype,updated,created`);
    return data.issues || [];
  } catch (err) { console.warn('Sprint issues error:', err.message); return []; }
}

function issueToTask(issue) {
  const f = issue.fields;
  let ws = '3';
  for (const l of (f.labels||[])) { const m = LABEL_TO_WS[l.toLowerCase()]; if (m) { ws = m; break; } }
  let phase = 'build';
  for (const l of (f.labels||[])) { const m = LABEL_TO_PHASE[l.toLowerCase()]; if (m) { phase = m; break; } }
  if (phase === 'build' && f.status) { const sp = STATUS_TO_PHASE[f.status.name]; if (sp) phase = sp; }
  const persons = [];
  if (f.assignee) { const p = normalizePerson(f.assignee.displayName); if (p) persons.push(p); }
  const startDate = f.customfield_10022 || f.customfield_10015 || null;
  const endDate = f.customfield_10023 || f.duedate || null;
  const start = dateToPeriod(startDate);
  const span = (startDate && endDate) ? computeSpan(startDate, endDate) : 1;
  const deps = [];
  for (const link of (f.issuelinks||[])) { if (link.type && link.type.name === 'Blocks' && link.inwardIssue) deps.push(link.inwardIssue.key); }
  return { id: issue.key, label: f.summary, ws, persons, start: start !== null ? start : 0, span, phase, jira: issue.key, deps };
}

function issueToSprintIssue(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status ? f.status.name : null,
    statusCategory: (f.status && f.status.statusCategory) ? f.status.statusCategory.key : null,
    assignee: f.assignee ? normalizePerson(f.assignee.displayName) : null,
    priority: f.priority ? f.priority.name : null,
    type: f.issuetype ? f.issuetype.name : null,
    labels: f.labels || [],
    updated: f.updated,
  };
}

async function main() {
  console.log('Syncing Jira LCAP -> data.json ...');
  const epics = await fetchAllEpics();
  const tasks = epics.map(issueToTask).filter(t => t.start !== null);

  let sprint = null;
  const activeSprint = await fetchActiveSprint();
  if (activeSprint) {
    console.log(`Active sprint: ${activeSprint.name} (ID: ${activeSprint.id})`);
    const issues = await fetchSprintIssues(activeSprint.id);
    sprint = { id: activeSprint.id, name: activeSprint.name, state: activeSprint.state, startDate: activeSprint.startDate || null, endDate: activeSprint.endDate || null, issues: issues.map(issueToSprintIssue) };
    console.log(`Sprint: ${sprint.issues.length} issues`);
  } else { console.log('No active sprint'); }

  const output = { generated: new Date().toISOString(), columns: COLUMNS, wsNames: WS_NAMES, tasks, sprint };
  const fs = await import('fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Written data.json: ${tasks.length} tasks${sprint ? ', ' + sprint.issues.length + ' sprint issues' : ''}`);
}

main().catch(err => { console.error('Sync failed:', err.message); process.exit(1); });
