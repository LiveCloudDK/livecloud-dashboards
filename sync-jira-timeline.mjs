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
  'mikkel kornval christoffersen':'mikkel','mikkel kornval':'mikkel','mikkel laursen':'mikkel',
  'michael thuren':'michael','michael krag':'michael',
  'edwin maldonado':'edwin','edwin leo':'edwin',
  'tony dieu':'tony','tony singh':'tony',
  'jakob højgård':'jakob','jakob lydersen':'jakob',
  'simon jensen':'simon',
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

// === Active work fetching (Kanban-compatible — no sprint boards needed) ===
async function fetchCurrentSprint() {
  // Fetch all active work: In Progress + Selected for Development
  // This replaces sprint-based queries since all boards are Kanban
  const jql = 'project = LCAP AND status IN ("In Progress", "Selected for Development") ORDER BY priority ASC, updated DESC';
  const fields = ['summary','status','assignee','priority','issuetype','labels','updated'];
  let allIssues = [];
  let nextPageToken = null;
  do {
    const body = { jql, maxResults: 200, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { console.log(`Active work JQL failed: ${resp.status}`); break; }
    const data = await resp.json();
    allIssues = allIssues.concat(data.issues || []);
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  if (allIssues.length === 0) {
    console.log('No active issues found');
    return null;
  }

  // Fetch issues in QA pipeline (excluding "Ready for release" — those are already tested)
  const testJql = 'project = LCAP AND status IN ("Ready for testing", "Ready for test", "READY FOR TEST AT DEV") ORDER BY priority ASC, updated DESC';
  let testIssues = [];
  nextPageToken = null;
  do {
    const body = { jql: testJql, maxResults: 200, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { console.log(`Test pipeline JQL failed: ${resp.status}`); break; }
    const data = await resp.json();
    testIssues = testIssues.concat(data.issues || []);
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  // Fetch "Ready for release" separately (tested, awaiting deploy)
  const releaseJql = 'project = LCAP AND status = "Ready for release" ORDER BY priority ASC, updated DESC';
  let releaseIssues = [];
  nextPageToken = null;
  do {
    const body = { jql: releaseJql, maxResults: 200, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { console.log(`Release pipeline JQL failed: ${resp.status}`); break; }
    const data = await resp.json();
    releaseIssues = releaseIssues.concat(data.issues || []);
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);

  const combinedIssues = [...allIssues, ...testIssues];
  console.log(`Found ${allIssues.length} active + ${testIssues.length} in QA + ${releaseIssues.length} ready for release = ${allIssues.length + testIssues.length + releaseIssues.length} total issues`);

  // Return as a synthetic "sprint" object for compatibility with the dashboard
  return {
    name: 'Aktivt Sprint',
    state: 'active',
    startDate: new Date().toISOString(),
    endDate: null,
    goal: '',
    issues: combinedIssues,
    testQueueCount: testIssues.length,
    readyForReleaseCount: releaseIssues.length,
    releaseIssues: releaseIssues.map(issueToSprintIssue),
  };
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

// === Fetch monthly velocity (resolved tickets per calendar month, last 6 months) ===
async function fetchVelocity() {
  const monthNames = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    months.push({
      label: `${monthNames[d.getMonth()]} ${d.getFullYear()}`,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }

  const results = [];
  for (const m of months) {
    try {
      const jql = `project = LCAP AND status CHANGED TO ("Done", "Closed", "Ready for release") DURING ("${m.start}", "${m.end}")`;
      const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: 0 }),
      });
      if (!resp.ok) { results.push({ month: m.label, tickets: 0 }); continue; }
      const data = await resp.json();
      const count = data.issues?.totalCount || data.total || 0;
      results.push({ month: m.label, tickets: count });
    } catch (e) {
      results.push({ month: m.label, tickets: 0 });
    }
  }
  console.log(`Velocity: ${results.map(r => `${r.month}:${r.tickets}`).join(', ')}`);
  return results;
}

// === Fetch all LCAP tickets (for live status overlay across all views) ===
async function fetchAllTickets() {
  const jql = 'project = LCAP ORDER BY key ASC';
  const fields = ['summary','status','assignee','priority','issuetype','labels','updated'];
  const tickets = {};
  let nextPageToken = null;
  let fetchedCount = 0;
  do {
    const body = { jql, maxResults: 200, fields };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) { console.log(`fetchAllTickets JQL failed: ${resp.status}`); break; }
    const data = await resp.json();
    for (const issue of (data.issues || [])) {
      const f = issue.fields;
      tickets[issue.key] = {
        key: issue.key,
        summary: f.summary,
        status: f.status ? f.status.name : '',
        statusCategory: f.status?.statusCategory?.key || 'new',
        assignee: f.assignee ? f.assignee.displayName : null,
        priority: f.priority ? f.priority.name : 'Medium',
        type: f.issuetype ? f.issuetype.name : 'Task',
        labels: (f.labels || []).map(l => l.name || l),
        updated: f.updated,
      };
      fetchedCount++;
    }
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  console.log(`Fetched ${fetchedCount} tickets for live status map`);
  return tickets;
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
  // Compute per-person ticket counts from raw Jira data
  let capacityCounts = null;
  if (sprintData) {
    const personCounts = {};
    const knownPersons = ['michael', 'tony', 'mikkel', 'jakob', 'edwin', 'simon'];
    knownPersons.forEach(p => { personCounts[p] = { active: 0, testQueue: 0, readyForRelease: 0, backlog: 0 }; });

    // Count active issues (In Progress + Selected for Development) per person
    for (const issue of sprintData.issues) {
      const assignee = issue.fields?.assignee?.displayName;
      if (!assignee) continue;
      const person = normalizePerson(assignee);
      if (person && personCounts[person]) personCounts[person].active++;
    }

    // Count test queue issues per person (from the raw testIssues stored in sprintData)
    // We already have testQueueCount and readyForReleaseCount as totals
    // For per-person breakdown, we need the raw issues — let's use sprint.issues statuses
    // Actually the combinedIssues includes test issues, so we can re-derive from status
    for (const issue of sprintData.issues) {
      const status = issue.fields?.status?.name;
      const assignee = issue.fields?.assignee?.displayName;
      if (!assignee) continue;
      const person = normalizePerson(assignee);
      if (!person || !personCounts[person]) continue;
      if (['Ready for testing', 'Ready for test', 'READY FOR TEST AT DEV'].includes(status)) {
        personCounts[person].testQueue++;
        personCounts[person].active--; // Don't double-count
      }
    }

    // Count ready for release per person
    for (const issue of (sprintData.releaseIssues || [])) {
      if (!issue.assignee) continue;
      const person = normalizePerson(issue.assignee);
      if (person && personCounts[person]) personCounts[person].readyForRelease++;
    }

    // Count backlog per person
    const backlogJql = 'project = LCAP AND status = "Backlog" AND assignee IS NOT EMPTY ORDER BY assignee ASC';
    let backlogIssues = [];
    let bpToken = null;
    do {
      const body = { jql: backlogJql, maxResults: 200, fields: ['assignee'] };
      if (bpToken) body.nextPageToken = bpToken;
      const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) { console.log(`Backlog JQL failed: ${resp.status}`); break; }
      const data = await resp.json();
      backlogIssues = backlogIssues.concat(data.issues || []);
      bpToken = data.nextPageToken || null;
    } while (bpToken);

    for (const issue of backlogIssues) {
      const assignee = issue.fields?.assignee?.displayName;
      if (!assignee) continue;
      const person = normalizePerson(assignee);
      if (person && personCounts[person]) personCounts[person].backlog++;
    }
    console.log(`Fetched ${backlogIssues.length} assigned backlog issues`);

    capacityCounts = personCounts;
    console.log('Per-person counts:', JSON.stringify(personCounts));

    sprint = {
      name: sprintData.name,
      state: sprintData.state,
      startDate: sprintData.startDate,
      endDate: sprintData.endDate,
      goal: sprintData.goal || '',
      issues: sprintData.issues.map(issueToSprintIssue),
      testQueueCount: sprintData.testQueueCount || 0,
      readyForReleaseCount: sprintData.readyForReleaseCount || 0,
      capacityCounts,
    };
  } else {
    console.log('No active or future sprint found');
  }

  // === Public Stats (for Showcase view) ===
  const publicStats = await fetchPublicStats();

  // === Live ticket status map (for overlay on detail + overview) ===
  const tickets = await fetchAllTickets();

  // === Monthly velocity for capacity view ===
  const velocity = await fetchVelocity();

  // === Festival data from FMS ===
  const festivals = await fetchFestivalData();

  const output = { tasks, columns: COLUMNS, wsNames: WS_NAMES, sprint, publicStats, tickets, velocity, festivals, generated: new Date().toISOString() };
  const fs = await import('node:fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data.json (${tasks.length} tasks, sprint: ${sprint ? sprint.name : 'none'}, QA queue: ${sprint?.testQueueCount || 0}, ready for release: ${sprint?.readyForReleaseCount || 0}, tickets: ${Object.keys(tickets).length}, velocity: ${velocity.length} months, festivals: ${festivals.length})`);
}

// === Public Stats — aggregate Jira data for showcase view ===
async function fetchPublicStats() {
  const statusGroups = {
    done: '"Done", "Closed"',
    readyForRelease: '"Ready for release"',
    inTest: '"Ready for testing", "Ready for test", "READY FOR TEST AT DEV"',
    inProgress: '"In Progress", "Selected for Development"',
    backlog: '"Backlog"',
  };

  const counts = {};
  for (const [key, statuses] of Object.entries(statusGroups)) {
    try {
      const jql = `project = LCAP AND status IN (${statuses})`;
      const resp = await fetch(`${JIRA_BASE}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: 0 }),
      });
      if (!resp.ok) { counts[key] = 0; continue; }
      const data = await resp.json();
      counts[key] = data.issues?.totalCount || data.total || 0;
    } catch (e) { counts[key] = 0; }
  }

  // Per-workstream breakdown (done vs total) using labels
  const wsLabels = {
    'Onboarding': 'ws1-onboarding', 'POS': 'ws2-pos', 'App': 'ws3-app',
    'Backend': 'ws4-backend', 'B2B': 'ws5-b2b', 'Webshop': 'ws6-webshop',
    'Personal': 'ws7-personal', 'POS API': 'ws8-pos-api', 'NFC/Wallet': 'ws9-nfc',
    'Gates': 'ws10-gates'
  };
  const byWorkstream = {};
  for (const [wsName, label] of Object.entries(wsLabels)) {
    try {
      const doneJql = `project = LCAP AND labels = "${label}" AND status IN ("Done", "Closed", "Ready for release")`;
      const totalJql = `project = LCAP AND labels = "${label}"`;
      const [doneResp, totalResp] = await Promise.all([
        fetch(`${JIRA_BASE}/rest/api/3/search/jql`, { method: 'POST', headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ jql: doneJql, maxResults: 0 }) }),
        fetch(`${JIRA_BASE}/rest/api/3/search/jql`, { method: 'POST', headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ jql: totalJql, maxResults: 0 }) }),
      ]);
      const doneData = doneResp.ok ? await doneResp.json() : { issues: { totalCount: 0 } };
      const totalData = totalResp.ok ? await totalResp.json() : { issues: { totalCount: 0 } };
      byWorkstream[wsName] = {
        done: doneData.issues?.totalCount || doneData.total || 0,
        total: totalData.issues?.totalCount || totalData.total || 0,
      };
    } catch (e) {
      byWorkstream[wsName] = { done: 0, total: 0 };
    }
  }

  const totalFeatures = counts.done + counts.readyForRelease + counts.inTest + counts.inProgress + counts.backlog;
  const featuresDone = counts.done + counts.readyForRelease;

  console.log(`Public stats: ${featuresDone}/${totalFeatures} done (${counts.done} done, ${counts.readyForRelease} ready for release, ${counts.inTest} in test, ${counts.inProgress} in progress, ${counts.backlog} backlog)`);

  return {
    totalFeatures,
    featuresDone,
    featuresInProgress: counts.inProgress,
    featuresInTest: counts.inTest,
    featuresReadyForRelease: counts.readyForRelease,
    featuresDoneCount: counts.done,
    featuresBacklog: counts.backlog,
    byWorkstream,
  };
}

// === Festival data from FMS APIs ===
async function fetchFestivalData() {
  let featuresConfig;
  try {
    const fs = await import('node:fs');
    featuresConfig = JSON.parse(fs.readFileSync('public-features.json', 'utf8'));
  } catch (e) {
    console.log('No public-features.json found, skipping festival data');
    return [];
  }

  const results = [];
  for (const fest of (featuresConfig.festivals || [])) {
    const result = { id: fest.id, name: fest.name, date: fest.date, capacity: fest.capacity, color: fest.color, colorEnd: fest.colorEnd, status: fest.status, kpi: fest.kpi || null };
    try {
      const resp = await fetch(fest.fmsUrl, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) { result.apiStatus = 'error'; result.apiError = resp.status; results.push(result); continue; }
      const data = await resp.json();
      // Extract what we can — structure may vary, we'll log it on first run
      result.apiStatus = 'ok';
      // FMS API wraps content under a `data` key
      const inner = data.data || data;
      const flat = typeof inner === 'object' && !Array.isArray(inner) ? inner : {};
      const meta = flat.metadata || {};
      result.apiData = {
        name: meta.name || flat.name || fest.name,
        season: meta.season || null,
        startsAt: meta.starts_at || null,
        endsAt: meta.ends_at || null,
        address: meta.address || null,
        artists: Array.isArray(flat.artists) ? flat.artists.length : Array.isArray(flat.talents) ? flat.talents.length : 0,
        events: flat.schedule?.events?.length || 0,
        venues: Array.isArray(flat.venues) ? flat.venues.length : 0,
        news: Array.isArray(flat.news) ? flat.news.length : 0,
        screens: Array.isArray(flat.screens) ? flat.screens.length : 0,
        media: Array.isArray(flat.media) ? flat.media.length : 0,
        vendors: Array.isArray(flat.vendors) ? flat.vendors.length : 0,
        venueNames: Array.isArray(flat.venues) ? flat.venues.map(v => v.name).filter(Boolean) : [],
      };
      console.log(`Festival ${fest.id}: API ok — ${result.apiData.artists} artists, ${result.apiData.events} events, ${result.apiData.venues} venues, ${result.apiData.news} news`);
    } catch (e) {
      result.apiStatus = 'unreachable';
      result.apiError = e.message;
      console.log(`Festival ${fest.id}: ${e.message}`);
    }
    results.push(result);
  }
  return results;
}

main().catch(e => { console.error(e); process.exit(1); });
