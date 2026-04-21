#!/usr/bin/env node
/**
 * sync-jira-timeline.mjs
 * Henter ALLE issues fra Jira-board 37 (LCAP) i ét kald og deriverer alt fra det:
 *   - tasks (epics med start/due date)
 *   - sprint (active sprint-objekt: In Progress + Selected + test-pipeline + ready for release)
 *   - tickets (map af alle issues på boardet → live status)
 *   - publicStats (pr. status + pr. workstream-label)
 *   - capacityCounts (pr. person)
 * Plus separate queries til velocity (historisk) og FMS festival-data.
 */

const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://u-ii-u.atlassian.net';
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_API_TOKEN;
const AUTH = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

const BOARD_ID = 37;

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

// === Fetch ALL issues on board 37 (paginated) ===
async function fetchBoardIssues() {
  const fields = [
    'summary','status','assignee','priority','issuetype','labels','updated','created',
    'customfield_10015','customfield_10022','duedate','parent'
  ].join(',');
  const all = [];
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const url = `${JIRA_BASE}/rest/agile/1.0/board/${BOARD_ID}/issue?startAt=${startAt}&maxResults=${maxResults}&fields=${fields}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Basic ${AUTH}`, 'Accept': 'application/json' }
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Board ${BOARD_ID} fetch failed: ${resp.status} ${body.slice(0, 200)}`);
    }
    const data = await resp.json();
    const batch = data.issues || [];
    all.push(...batch);
    const total = data.total || 0;
    if (batch.length === 0 || startAt + batch.length >= total) break;
    startAt += batch.length;
    if (startAt > 5000) break; // safety
  }
  console.log(`Fetched ${all.length} issues from board ${BOARD_ID}`);
  return all;
}

// === Transforms ===
function issueToSprintIssue(issue) {
  const f = issue.fields;
  return {
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
}

function issueToTicket(issue) {
  const f = issue.fields;
  return {
    key: issue.key,
    summary: f.summary,
    status: f.status ? f.status.name : '',
    statusCategory: f.status?.statusCategory?.key || 'new',
    assignee: f.assignee ? f.assignee.displayName : null,
    priority: f.priority ? f.priority.name : 'Medium',
    type: f.issuetype ? f.issuetype.name : 'Task',
    labels: (f.labels || []).map(l => l.name || l),
    updated: f.updated,
    created: f.created,
  };
}

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

// === Derive sprint + capacity + publicStats from board issues ===
function deriveSprint(boardIssues) {
  const activeStatuses = new Set(['In Progress', 'Selected for Development']);
  const testStatuses = new Set(['Ready for testing', 'Ready for test', 'READY FOR TEST AT DEV']);
  const releaseStatus = 'Ready for release';

  const activeIssues = boardIssues.filter(i => activeStatuses.has(i.fields.status?.name));
  const testIssues = boardIssues.filter(i => testStatuses.has(i.fields.status?.name));
  const releaseIssues = boardIssues.filter(i => i.fields.status?.name === releaseStatus);

  if (activeIssues.length === 0 && testIssues.length === 0 && releaseIssues.length === 0) {
    return null;
  }

  const combined = [...activeIssues, ...testIssues];
  const sortByPri = (a, b) => {
    const pri = { Highest:0, High:1, Medium:2, Low:3, Lowest:4 };
    const pa = pri[a.fields.priority?.name] ?? 9;
    const pb = pri[b.fields.priority?.name] ?? 9;
    if (pa !== pb) return pa - pb;
    return new Date(b.fields.updated).getTime() - new Date(a.fields.updated).getTime();
  };
  combined.sort(sortByPri);
  releaseIssues.sort(sortByPri);

  // Per-person counts
  const knownPersons = ['michael', 'tony', 'mikkel', 'jakob', 'edwin', 'simon'];
  const personCounts = {};
  knownPersons.forEach(p => { personCounts[p] = { active: 0, testQueue: 0, readyForRelease: 0, backlog: 0 }; });

  for (const issue of activeIssues) {
    const assignee = issue.fields?.assignee?.displayName;
    if (!assignee) continue;
    const person = normalizePerson(assignee);
    if (person && personCounts[person]) personCounts[person].active++;
  }
  for (const issue of testIssues) {
    const assignee = issue.fields?.assignee?.displayName;
    if (!assignee) continue;
    const person = normalizePerson(assignee);
    if (person && personCounts[person]) personCounts[person].testQueue++;
  }
  for (const issue of releaseIssues) {
    const assignee = issue.fields?.assignee?.displayName;
    if (!assignee) continue;
    const person = normalizePerson(assignee);
    if (person && personCounts[person]) personCounts[person].readyForRelease++;
  }
  for (const issue of boardIssues) {
    if (issue.fields.status?.name !== 'Backlog') continue;
    const assignee = issue.fields?.assignee?.displayName;
    if (!assignee) continue;
    const person = normalizePerson(assignee);
    if (person && personCounts[person]) personCounts[person].backlog++;
  }

  return {
    name: 'Aktivt Sprint',
    state: 'active',
    startDate: new Date().toISOString(),
    endDate: null,
    goal: '',
    issues: combined.map(issueToSprintIssue),
    testQueueCount: testIssues.length,
    readyForReleaseCount: releaseIssues.length,
    releaseIssues: releaseIssues.map(issueToSprintIssue),
    capacityCounts: personCounts,
  };
}

function derivePublicStats(boardIssues) {
  const statusCounts = { done: 0, readyForRelease: 0, inTest: 0, inProgress: 0, backlog: 0 };
  const testStatuses = new Set(['Ready for testing', 'Ready for test', 'READY FOR TEST AT DEV']);
  const activeStatuses = new Set(['In Progress', 'Selected for Development']);
  const doneStatuses = new Set(['Done', 'Closed']);

  for (const issue of boardIssues) {
    const s = issue.fields.status?.name || '';
    if (doneStatuses.has(s)) statusCounts.done++;
    else if (s === 'Ready for release') statusCounts.readyForRelease++;
    else if (testStatuses.has(s)) statusCounts.inTest++;
    else if (activeStatuses.has(s)) statusCounts.inProgress++;
    else if (s === 'Backlog') statusCounts.backlog++;
  }

  const wsLabels = {
    'Onboarding': 'ws1-onboarding', 'POS': 'ws2-pos', 'App': 'ws3-app',
    'Backend': 'ws4-backend', 'B2B': 'ws5-b2b', 'Webshop': 'ws6-webshop',
    'Personal': 'ws7-personal', 'POS API': 'ws8-pos-api', 'NFC/Wallet': 'ws9-nfc',
    'Gates': 'ws10-gates'
  };
  const byWorkstream = {};
  for (const [wsName, label] of Object.entries(wsLabels)) {
    const matching = boardIssues.filter(i => (i.fields.labels || []).some(l => (l.name || l) === label));
    const done = matching.filter(i => {
      const s = i.fields.status?.name || '';
      return doneStatuses.has(s) || s === 'Ready for release';
    }).length;
    byWorkstream[wsName] = { done, total: matching.length };
  }

  const totalFeatures = statusCounts.done + statusCounts.readyForRelease + statusCounts.inTest + statusCounts.inProgress + statusCounts.backlog;
  const featuresDone = statusCounts.done + statusCounts.readyForRelease;

  return {
    totalFeatures,
    featuresDone,
    featuresInProgress: statusCounts.inProgress,
    featuresInTest: statusCounts.inTest,
    featuresReadyForRelease: statusCounts.readyForRelease,
    featuresDoneCount: statusCounts.done,
    featuresBacklog: statusCounts.backlog,
    byWorkstream,
  };
}

// === Monthly velocity (requires changelog/DURING JQL, project-scoped) ===
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
      // Scope to board's filter: use project JQL (board filter already applies project=LCAP)
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

// === Festival data from FMS APIs (unchanged) ===
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
      result.apiStatus = 'ok';
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

// === Main ===
async function main() {
  const boardIssues = await fetchBoardIssues();

  // Epics → timeline-tasks
  const epics = boardIssues.filter(i => i.fields.issuetype?.name === 'Epic');
  const tasks = epics.map(issueToTask).filter(t => t.start !== null);
  console.log(`Extracted ${epics.length} epics (${tasks.length} with valid start dates)`);

  // All tickets map (live status overlay)
  const tickets = {};
  for (const issue of boardIssues) {
    tickets[issue.key] = issueToTicket(issue);
  }

  // Synthetic sprint
  const sprint = deriveSprint(boardIssues);
  console.log(`Sprint: ${sprint ? `${sprint.issues.length} active+test, ${sprint.readyForReleaseCount} ready for release` : 'none'}`);
  if (sprint) console.log('Per-person counts:', JSON.stringify(sprint.capacityCounts));

  // Aggregated stats
  const publicStats = derivePublicStats(boardIssues);
  console.log(`Public stats: ${publicStats.featuresDone}/${publicStats.totalFeatures} done`);

  // Historical velocity (separate query)
  const velocity = await fetchVelocity();

  // Festival data (FMS)
  const festivals = await fetchFestivalData();

  const output = {
    tasks,
    columns: COLUMNS,
    wsNames: WS_NAMES,
    sprint,
    publicStats,
    tickets,
    velocity,
    festivals,
    boardId: BOARD_ID,
    generated: new Date().toISOString(),
  };
  const fs = await import('node:fs');
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log(`Wrote data.json (board ${BOARD_ID}: ${boardIssues.length} issues, ${tasks.length} tasks, sprint: ${sprint ? sprint.name : 'none'}, tickets: ${Object.keys(tickets).length}, velocity: ${velocity.length} months, festivals: ${festivals.length})`);
}

main().catch(e => { console.error(e); process.exit(1); });
