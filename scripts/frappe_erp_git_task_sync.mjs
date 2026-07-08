import fs from 'node:fs';

const ERP_URL = (process.env.ERP_URL || 'https://erp.hippoclouds.com').replace(/\/$/, '');
const ERP_USER = process.env.ERP_USER;
const ERP_PASS = process.env.ERP_PASS;
const INPUT_FILE = process.env.INPUT_FILE || 'data/fleet_erp_updates.json';
const ERP_PROJECT = process.env.ERP_PROJECT || '';
const PROJECT_SEARCH = process.env.PROJECT_SEARCH || 'FLEET';
const DRY_RUN = process.env.DRY_RUN !== '0';
const CREATE_PROJECT_IF_MISSING = process.env.CREATE_PROJECT_IF_MISSING === '1';

if (!ERP_USER || !ERP_PASS) {
  console.error('Missing ERP_USER or ERP_PASS. Use GitHub Secrets or local environment variables. Do not hardcode credentials.');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
let sid = '';
let csrfToken = '';
let resolvedProject = ERP_PROJECT || input.erpProject || '';

function url(path) {
  return `${ERP_URL}${path}`;
}

function splitSetCookie(header) {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,\s]+=)/g).map((part) => part.trim());
}

function cookieValue(setCookieHeader, cookieName) {
  for (const cookie of splitSetCookie(setCookieHeader)) {
    const pair = cookie.split(';')[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === cookieName) {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return '';
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

function isUnsafe(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase());
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    ...(sid ? { Cookie: `sid=${sid}` } : {}),
    ...(isUnsafe(method) && csrfToken ? { 'X-Frappe-CSRF-Token': csrfToken } : {}),
    ...(options.headers || {})
  };

  let body = options.body;
  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    body = body.toString();
  } else if (body && typeof body === 'object') {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }

  const response = await fetch(url(path), { ...options, method, headers, body });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    const details = typeof parsed === 'string' ? parsed.slice(0, 1500) : JSON.stringify(parsed, null, 2);
    throw new Error(`API failed ${response.status} ${method} ${path}\n${details}`);
  }

  return { body: parsed, text, headers: response.headers };
}

async function login() {
  console.log('Logging in using the same cookie pattern as worker.js...');

  const loginResponse = await fetch(url('/api/method/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usr: ERP_USER, pwd: ERP_PASS })
  });

  const setCookie = loginResponse.headers.get('set-cookie') || '';
  sid = cookieValue(setCookie, 'sid');
  csrfToken = cookieValue(setCookie, 'frappe_csrf_token');

  if (!loginResponse.ok || !sid || sid === 'Guest') {
    const text = await loginResponse.text().catch(() => '');
    throw new Error(`ERP login failed or did not return sid cookie. Status=${loginResponse.status}. ${text.slice(0, 500)}`);
  }

  if (!csrfToken) {
    throw new Error('ERP login succeeded but did not return frappe_csrf_token cookie. Existing worker.js depends on this cookie; check ERP response headers or session policy.');
  }

  console.log('ERP session cookie and CSRF cookie acquired from login response.');

  const me = await api('/api/method/frappe.auth.get_logged_user');
  if (!me.body?.message || me.body.message === 'Guest') {
    throw new Error(`ERP session verification failed. get_logged_user returned: ${JSON.stringify(me.body)}`);
  }
  console.log(`Logged in as: ${me.body.message}`);
}

async function validateExactProject(projectName) {
  if (!projectName) return false;
  try {
    await api('/api/method/frappe.client.validate_link', {
      method: 'POST',
      body: {
        doctype: 'Project',
        docname: projectName,
        fields: ['name', 'project_name', 'status']
      }
    });
    resolvedProject = projectName;
    console.log(`Project validated: ${resolvedProject}`);
    return true;
  } catch (error) {
    console.log(`Exact project validation failed for ${projectName}: ${String(error.message).split('\n')[0]}`);
    return false;
  }
}

async function listProjects(field, search) {
  const query = qs({
    fields: JSON.stringify(['name', 'project_name', 'status']),
    filters: JSON.stringify([[field, 'like', `%${search}%`]]),
    limit_page_length: '20'
  });
  const response = await api(`/api/resource/Project?${query}`);
  return response.body.data || [];
}

async function findProject() {
  if (await validateExactProject(resolvedProject)) return resolvedProject;

  const search = PROJECT_SEARCH || resolvedProject || input.erpProject || 'FLEET';
  let projects = [];

  try {
    projects = await listProjects('name', search);
    if (projects.length === 0) projects = await listProjects('project_name', search);
  } catch (error) {
    throw new Error(`Could not search Project records. Likely root cause: ERP user lacks Project read permission. Original error: ${error.message}`);
  }

  if (projects.length > 0) {
    const exact = projects.find((p) => p.name === resolvedProject || p.project_name === resolvedProject);
    const chosen = exact || projects[0];
    resolvedProject = chosen.name;
    console.log(`Project discovered: ${resolvedProject}${chosen.project_name ? ` (${chosen.project_name})` : ''}`);
    return resolvedProject;
  }

  if (!CREATE_PROJECT_IF_MISSING) {
    throw new Error(`No ERP Project matched ${JSON.stringify(search)}. Set ERP_PROJECT to the exact Project document name, adjust project_search, or run with create_project_if_missing=1.`);
  }

  const projectName = resolvedProject || input.erpProject || 'FLEET-MANAGEMENT';
  const created = await api('/api/resource/Project', {
    method: 'POST',
    body: { project_name: projectName, status: 'Open' }
  });
  resolvedProject = created.body.data?.name || projectName;
  console.log(`Project created: ${resolvedProject}`);
  return resolvedProject;
}

function taskPayload(task) {
  const description = [];
  if (task.branch) description.push(`Branch: ${task.branch}`);
  if (task.pr) description.push(`PR: #${task.pr}`);
  if (task.from || task.to) description.push(`Timeline UTC: ${task.from || 'unknown'} to ${task.to || 'unknown'}`);
  if (input.source?.repository) description.push(`Repository: ${input.source.repository}`);
  if (input.source?.latestObservedCommit) description.push(`Latest observed commit: ${input.source.latestObservedCommit}`);
  if (task.description) description.push('', task.description);

  return {
    subject: task.subject,
    project: resolvedProject,
    status: task.status || 'Open',
    priority: task.priority || 'Medium',
    description: description.join('\n')
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
  const response = await api(`/api/resource/Task?${query}`);
  return response.body.data?.[0] || null;
}

async function upsertTask(task) {
  const existing = await findTask(task.subject);
  const payload = taskPayload(task);

  if (DRY_RUN) {
    console.log(`[DRY RUN] ${existing ? 'UPDATE' : 'CREATE'}: ${payload.subject} -> ${payload.status}`);
    return;
  }

  if (existing) {
    const updated = await api(`/api/resource/Task/${encodeURIComponent(existing.name)}`, {
      method: 'PUT',
      body: payload
    });
    console.log(`Updated: ${updated.body.data?.name || existing.name}`);
    return;
  }

  const created = await api('/api/resource/Task', {
    method: 'POST',
    body: payload
  });
  console.log(`Created: ${created.body.data?.name || payload.subject}`);
}

try {
  await login();
  await findProject();

  const tasks = [input.dailySummaryTask, ...input.completedTasks, ...input.nextTasks].filter(Boolean);
  for (const task of tasks) await upsertTask(task);

  console.log('\nSummary');
  console.log(`Project: ${resolvedProject}`);
  console.log(`Tasks processed: ${tasks.length}`);
  console.log(DRY_RUN ? 'Dry run completed. No ERP changes were made.' : 'ERP update completed.');
} catch (error) {
  console.error('\nERP Fleet Task Sync failed.');
  console.error(error.message || error);
  process.exit(1);
}
