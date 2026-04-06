#!/usr/bin/env node
/**
 * sync-jira-timeline.mjs
 * Fetches epics + active sprint from Jira LCAP and generates data.json.
 * Uses POST /rest/api/3/search/jql for epics and sprint issues.
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://u-ii-u.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
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

const LABEL_TO_WS = {'onboarding':'1','pos':'2','app':'3','backend':'4','fms':'4','commerce':'4'};
const WS_NAMES = {'1':'Onboarding','2':'POS','3':'App','4':'Backend/FMS','5':'B2B','6':'Webshop','7':'Personal','8':'POS API','9':'NFC/Wallet','10':'Gates','all':'Alle'};
const LABEL_TO_PHASE = {'phase-build':'build','phase-test':'test','phase-live':'live','phase-scale':'scale','phase-polish':'polish','phase-critical':'critical','phase-meeting':'meeting'};
const STATUS_TO_PHASE = {'Done':'live','Released':'live'};

const PERSON_MAP = {
  'mikkel laursen':'mikkel','michael krag':'michael','edwin leo':'edwin',
  'tony singh':'tony','jakob lydersen':'jakob',
};
function normalizePerson(n) { return PERSON_MAP[n.toLowerCase()] || null; }

function dateToPeriod(d) {
  if (!d) return null;
  const dt = new Date(d);
  for (let i = PERIOD_STARTS.length - 1; i >= 0; i--) {
    if (dt >= PERIOD_STARTS[i]) return i;
  }
  return null;
}

function columnForDate(d) {
  const i = dateToPeriod(d);
  return i !== null ? COLUMNS[i] : null;
}

function endColumnForDate(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (dt > PERIOD_END) return COLUMNS[COLUMNS.length - 1];
  for (let i = PERIOD_STARTS.length - 1; i >= 0; i--) {
    if (dt >= PERIOD_STARTS[i]) return COLUMNS[i];
  }
  return null;
}

function computeSpan(s, e) {
  const sp = dateToPeriod(s), ep = dateToPeriod(e);
  if (sp === null || ep === null) return 1;
  return Math.max(1, ep - sp + 1);
}

async function jiraGet(path) {
  const resp = await fetch(`${JIRA_BASE}${path}`, { headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json' } });
  if (!resp.ok) throw new Error(`Jira GET ${path} failed: ${resp.status}`);
  return resp.json();
}

async function fetchEpics() {
  const jql = 'project = LCAP AND issuetype = Epic ORDER BY rank ASC';
  const fields = ['summary','status','assignee','priority','labels','customfield_10015','customfield_10022','duedate'];
  let all = [];
  let nextPageToken = null;
  do {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Epic search failed: ${resp.status}`);
    const data = await resp.json();
    all = all.concat(data.issues || []);
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  console.log(`Fetched ${all.length} epics`);
  return all;
}

// === Sprint data fetching (JQL-based, works with Kanban boards) ===
async function fetchCurrentSprint() {
  const jqlQueries = [
    'project = LCAP AND sprint in openSprints() ORDER BY updated DESC',
    'project = LCAP AND sprint in futureSprints() ORDER BY updated DESC',
  ];

  for (const jql of jqlQueries) {
    let allIssues = [];
    let nextPageToken = null;
    do {
      const body = { jql, maxResults: 100, fields: ['summary','status','assignee','priority','issuetype','labels','updated','customfield_10020'] };
      if (nextPageToken) body.nextPageToken = nextPageToken;
      const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) { console.log(`Sprint JQL failed (${resp.status}): ${jql}`); break; }
      const data = await resp.json();
      allIssues = allIssues.concat(data.issues || []);
      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken);

    if (allIssues.length === 0) continue;

    // Extract sprint metadata from customfield_10020
    const sprintMap = {};
    for (const issue of allIssues) {
      const sprints = issue.fields.customfield_10020 || [];
      for (const s of sprints) {
        if (s.state === 'active' || s.state === 'future') {
          if (!sprintMap[s.id]) sprintMap[s.id] = { ...s, issues: [] };
          sprintMap[s.id].issues.push(issue);
        }
      }
    }

    // Prefer active over future; if multiple, pick earliest start
    const sprints = Object.values(sprintMap);
    const active = sprints.filter(s => s.state === 'active');
    const chosen = active.length > 0
      ? active.sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0]
      : sprints.sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];

    if (chosen) {
      console.log(`Found sprint: ${chosen.name} (state: ${chosen.state}, ${chosen.issues.length} issues)`);
      return chosen;
    }
  }
  return null;
}

function issueToSprintIssue(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status.name,
    statusCategory: f.status.statusCategory.key,
    assignee: f.assignee ? f.assignee.displayName : null,
    priority: f.priority ? f.priority.name : 'Medium',
    type: f.issuetype ? f.issuetype.name : 'Task',
    labels: (f.labels || []).map(l => l.name || l),
    updated: f.updated,
  };
}

// === Epic transform ===
function issueToTask(issue) {
  const f = issue.fields;
  let ws = 'all';
  (f.labels || []).forEach(l => { const m = LABEL_TO_WS[(l.name||l).toLowerCase()]; if (m) ws = m; });
  let phase = 'build';
  (f.labels || []).forEach(l => { const sp = LABEL_TO_PHASE[(l.name||l).toLowerCase()]; if (sp) phase = sp; });
  if (f.status) { const sp = STATUS_TO_PHASE[f.status.name]; if (sp) phase = sp; }
  const persons = [];
  if (f.assignee) { const p = normalizePerson(f.assignee.displayName); if (p) persons.push(p); }
  const startDate = f.customfield_10022 || f.customfield_10015 || null;
  const endDate = f.duedate || null;
  return {
    id: issue.key,
    title: `[${issue.key}] ${f.summary}`,
    ws,
    phase,
    persons,
    start: columnForDate(startDate),
    end: endColumnForDate(endDate) || columnForDate(startDate),
    span: computeSpan(startDate, endDate),
    priority: f.priority ? f.priority.name : 'Medium',
    status: f.status ? f.status.name : '',
  };
}

// === Main ===
async function main() {
  const epics = await fetchEpics();
  const tasks = epics.map(issueToTask).filter(t => t.start !== null);

  let sprint = null;
  const sprintData = await fetchCurrentSprint();
  if (sprintData) {
    sprint = {
      name: sprintData.name,
      state: sprintData.state,
      startDate: sprintData.startDate,
      endDate: sprintData.endDate,
      goal: sprintData.goal || '',
      issues: sprintData.issues.map(issueToSprintIssue),
    };
  } else {
    console.log('No active or future sprint found');
  }

  const output = { tasks, columns: COLUMNS, wsNames: WS_NAMES, sprint, generated: new Date().toISOString() };
  const fs = await import('node:fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data.json (${tasks.length} tasks, sprint: ${sprint ? sprint.name : 'none'})`);
}

main().catch(e => { console.error(e); process.exit(1); });
