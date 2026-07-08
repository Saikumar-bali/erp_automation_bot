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
const cookieJar = new Map();
let csrfToken = '';
let resolvedProject = ERP_PROJECT || input.erpProject || '';

function cleanUrl(path) {
  return `${ERP_URL}${path}`;
}

function cookieHeader() {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

function storeCookies(setCookieHeader) {
  if (!setCookieHeader) return;

  // GitHub/Node fetch exposes set-cookie as a combined string. Split only at real cookie boundaries.
  const cookies = setCookieHeader.split(/,(?=\s*[^;=]+=[^;]+)/g);
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0]?.trim();
    if (!pair || !pair.includes('=')) continue;
    const [key, ...valueParts] = pair.split('=');
    const value = valueParts.join('=');
    if (key && value) cookieJar.set(key, value);
  }
}

function isUnsafeMethod(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || 'GET').toUpperCase());
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    Accept: 'application/json',
    ...(cookieJar.size ? { Cookie: cookieHeader() } : {}),
    ...(isUnsafeMethod(method) && csrfToken ? { 'X-Frappe-CSRF-Token': csrfToken } : {}),
    ...(options.headers || {})
  };

  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams) && !(body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }

  if (body instanceof URLSearchParams) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
    body = body.toString();
  }

  const res = await fetch(cleanUrl(path), {
    ...options,
    method,
    headers,
    body
  });

  storeCookies(res.headers.get('set-cookie'));

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const msg = typeof parsed === 'string' ? parsed.slice(0, 1200) : JSON.stringify(parsed, null, 2);
    if (res.status === 403 && /csrf/i.test(msg)) {
      throw new Error(
        `ERP rejected a state-changing request because the CSRF token was missing or invalid. ` +
        `This script now fetches and sends X-Frappe-CSRF-Token; rerun after this commit. Original response: ${msg}`
      );
    }
    throw new Error(`API failed ${res.status} ${method} ${path}\n${msg}`);
  }

  return { body: parsed, text };
}

function qs(params) {
  return new URLSearchParams(params).toString();
}

async function login() {
  console.log('Logging in to ERP...');
  const form = new URLSearchParams({ usr: ERP_USER, pwd: ERP_PASS });
  await api('/api/method/login', { method: 'POST', body: form });

  const me = await api('/api/method/frappe.auth.get_logged_user');
  console.log(`Logged in as: ${me.body.message}`);

  await fetchCsrfToken();
}

async function fetchCsrfToken() {
  try {
    const res = await api('/api/method/frappe.sessions.get_csrf_token');
    const token = res.body?.message || res.body?.csrf_token;
    if (typeof token === 'string' && token.trim()) {
      csrfToken = token.trim();
      console.log('CSRF token acquired from frappe.sessions.get_csrf_token.');
      return;
    }
  } catch (err) {
    console.log('CSRF token method did not return a token; trying /app HTML fallback.');
  }

  const res = await api('/app');
  const html = res.text || '';
  const match = html.match(/csrf_token["']?\s*[:=]\s*["']([^"']+)["']/i) || html.match(/frappe\.csrf_token\s*=\s*["']([^"']+)["']/i);
  if (match?.[1]) {
    csrfToken = match[1];
    console.log('CSRF token acquired from /app HTML.');
    return;
  }

  throw new Error('Unable to acquire Frappe CSRF token after login. State-changing ERP API calls cannot run safely without it.');
}

async function tryValidateProject(projectName) {
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
  } catch (err) {
    console.log(`Exact project validation failed for ${projectName}: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function listProjectsByFilter(field, value) {
  const query = qs({
    fields: JSON.stringify(['name', 'project_name', 'status']),
    filters: JSON.stringify([[field, 'like', `%${value}%`]]),
    limit_page_length: '20'
  });
  const res = await api(`/api/resource/Project?${query}`);
  return res.body.data || [];
}

async function findProject() {
  if (await tryValidateProject(resolvedProject)) return resolvedProject;

  const search = PROJECT_SEARCH || resolvedProject || 'FLEET';
  let projects = [];

  try {
    projects = await listProjectsByFilter('name', search);
    if (projects.length === 0) projects = await listProjectsByFilter('project_name', search);
  } catch (err) {
    throw new Error(
      `Could not search ERP Project records. Root cause is likely Project read permission or Project doctype access. ` +
      `Set ERP_PROJECT to the exact Project document name if known. Original error: ${err.message}`
    );
  }

  if (projects.length > 0) {
    const exact = projects.find((p) => p.name === resolvedProject || p.project_name === resolvedProject);
    const chosen = exact || projects[0];
    resolvedProject = chosen.name;
    console.log(`Project discovered: ${resolvedProject}${chosen.project_name ? ` (${chosen.project_name})` : ''}`);
    return resolvedProject;
  }

  if (!CREATE_PROJECT_IF_MISSING) {
    throw new Error(
      `No ERP Project matched ${JSON.stringify(search)}. This is the next possible failure after CSRF. ` +
      `Set ERP_PROJECT to the exact Project document name, change project_search, or run with create_project_if_missing=1.`
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
    body: { project_name: projectName, status: 'Open' }
  });
  resolvedProject = created.body.data?.name || projectName;
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
  const res = await api(`/api/resource/Task?${query}`);
  return res.body.data?.[0] || null;
}

async function upsertTask(task) {
  const existing = await findTask(task.subject);
  const payload = taskPayload(task);

  if (DRY_RUN) {
    console.log(`[DRY RUN] ${existing ? 'UPDATE' : 'CREATE'}: ${payload.subject} -> ${payload.status}`);
    return { action: existing ? 'update' : 'create', subject: payload.subject, dryRun: true };
  }

  if (existing) {
    const updated = await api(`/api/resource/Task/${encodeURIComponent(existing.name)}`, {
      method: 'PUT',
      body: payload
    });
    console.log(`Updated: ${updated.body.data?.name || existing.name}`);
    return { action: 'updated', name: updated.body.data?.name || existing.name, subject: payload.subject };
  }

  const created = await api('/api/resource/Task', {
    method: 'POST',
    body: payload
  });
  console.log(`Created: ${created.body.data?.name || payload.subject}`);
  return { action: 'created', name: created.body.data?.name, subject: payload.subject };
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
  console.error('\nERP Fleet Task Sync failed.');
  console.error(err.message || err);
  process.exit(1);
}
