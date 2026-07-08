import fs from 'node:fs';

const ERP_URL = (process.env.ERP_URL || 'https://erp.hippoclouds.com').replace(/\/$/, '');
const ERP_USER = process.env.ERP_USER;
const ERP_PASS = process.env.ERP_PASS;
const INPUT_FILE = process.env.INPUT_FILE || 'data/fleet_git_tasks_2026-07-08.json';
const ERP_PROJECT = process.env.ERP_PROJECT || '';
const PROJECT_SEARCH = process.env.PROJECT_SEARCH || 'FLEET';
const DRY_RUN = process.env.DRY_RUN !== '0';
const CREATE_PROJECT_IF_MISSING = process.env.CREATE_PROJECT_IF_MISSING === '1';

if (!ERP_USER || !ERP_PASS) {
  console.error('Missing ERP_USER or ERP_PASS. Use GitHub Secrets or local environment variables. Do not hardcode credentials.');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
let cookie = '';
let resolvedProject = ERP_PROJECT || input.erpProject || '';

function cleanUrl(path) {
  return `${ERP_URL}${path}`;
}

async function api(path, options = {}) {
  const res = await fetch(cleanUrl(path), {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(options.headers || {})
    }
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie
      .split(',')
      .map((c) => c.split(';')[0])
      .join('; ');
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!res.ok) {
    const msg = typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body, null, 2);
    throw new Error(`API failed ${res.status} ${path}\n${msg}`);
  }

  return body;
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

async function login() {
  await api('/api/method/login', {
    method: 'POST',
    body: JSON.stringify({ usr: ERP_USER, pwd: ERP_PASS })
  });
  const me = await api('/api/method/frappe.auth.get_logged_user');
  console.log(`Logged in as: ${me.message}`);
}

async function tryValidateProject(projectName) {
  if (!projectName) return false;
  try {
    await api('/api/method/frappe.client.validate_link', {
      method: 'POST',
      body: JSON.stringify({
        doctype: 'Project',
        docname: projectName,
        fields: ['name', 'project_name', 'status']
      })
    });
    resolvedProject = projectName;
    console.log(`Project validated: ${resolvedProject}`);
    return true;
  } catch {
    return false;
  }
}

async function findProject() {
  if (await tryValidateProject(resolvedProject)) return resolvedProject;

  const search = PROJECT_SEARCH || resolvedProject || 'FLEET';
  const query = qs({
    fields: JSON.stringify(['name', 'project_name', 'status']),
    or_filters: JSON.stringify([
      ['name', 'like', `%${search}%`],
      ['project_name', 'like', `%${search}%`]
    ]),
    limit_page_length: '20'
  });

  const body = await api(`/api/resource/Project?${query}`);
  const projects = body.data || [];

  if (projects.length > 0) {
    const exact = projects.find((p) => p.name === resolvedProject || p.project_name === resolvedProject);
    const chosen = exact || projects[0];
    resolvedProject = chosen.name;
    console.log(`Project discovered: ${resolvedProject}${chosen.project_name ? ` (${chosen.project_name})` : ''}`);
    return resolvedProject;
  }

  if (!CREATE_PROJECT_IF_MISSING) {
    throw new Error(
      `No Project matched ${JSON.stringify(search)}. Set ERP_PROJECT to the exact Project name, or run with CREATE_PROJECT_IF_MISSING=1 if you want the script to create it.`
    );
  }

  const projectName = resolvedProject || input.erpProject || 'FLEET-MANAGEMENT';
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create Project: ${projectName}`);
    resolvedProject = projectName;
    return resolvedProject;
  }

  const created = await api('/api/resource/Project', {
    method: 'POST',
    body: JSON.stringify({ project_name: projectName, status: 'Open' })
  });
  resolvedProject = created.data?.name || projectName;
  console.log(`Project created: ${resolvedProject}`);
  return resolvedProject;
}

function taskPayload(task) {
  const lines = [];
  if (task.branch) lines.push(`Branch: ${task.branch}`);
  if (task.pr) lines.push(`PR: #${task.pr}`);
  if (task.from || task.to) lines.push(`Timeline UTC: ${task.from || 'unknown'} to ${task.to || 'unknown'}`);
  if (input.source?.repository) lines.push(`Repository: ${input.source.repository}`);
  if (input.source?.latestObservedCommit) lines.push(`Latest observed commit: ${input.source.latestObservedCommit}`);
  if (task.description) lines.push('', task.description);

  return {
    subject: task.subject,
    project: resolvedProject,
    status: task.status || 'Open',
    priority: task.priority || 'Medium',
    description: lines.join('\n')
  };
}

async function findTask(subject) {
  const query = qs({
    fields: JSON.stringify(['name', 'subject', 'status', 'project']),
    filters: JSON.stringify([
      ['project', '=', resolvedProject],
      ['subject', '=', subject]
    ]),
    limit_page_length: '1'
  });
  const body = await api(`/api/resource/Task?${query}`);
  return body.data?.[0] || null;
}

async function upsertTask(task) {
  const existing = await findTask(task.subject);
  const payload = taskPayload(task);

  if (DRY_RUN) {
    console.log(`[DRY RUN] ${existing ? 'UPDATE' : 'CREATE'}: ${payload.subject} -> ${payload.status}`);
    return { action: existing ? 'update' : 'create', subject: payload.subject, dryRun: true };
  }

  if (existing) {
    const body = await api(`/api/resource/Task/${encodeURIComponent(existing.name)}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    console.log(`Updated: ${body.data?.name || existing.name}`);
    return { action: 'updated', name: body.data?.name || existing.name, subject: payload.subject };
  }

  const body = await api('/api/resource/Task', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  console.log(`Created: ${body.data?.name || payload.subject}`);
  return { action: 'created', name: body.data?.name, subject: payload.subject };
}

try {
  await login();
  await findProject();

  const tasks = [input.dailySummaryTask, ...input.completedTasks, ...input.nextTasks].filter(Boolean);
  const results = [];
  for (const task of tasks) results.push(await upsertTask(task));

  console.log('\nSummary');
  console.log(`Project: ${resolvedProject}`);
  console.log(`Tasks processed: ${results.length}`);
  console.log(DRY_RUN ? 'Dry run completed. No ERP changes were made.' : 'ERP update completed.');
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
