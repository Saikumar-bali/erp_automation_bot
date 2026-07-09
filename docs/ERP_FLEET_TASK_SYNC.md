# ERP Fleet Task Sync

This workflow creates or updates Frappe/ERPNext `Task` records from one stable Fleet Management update file.

## Daily rule

In future, update only this file when work is completed or next work changes:

```text
data/fleet_erp_updates.json
```

A push to `master` that changes the ERP sync files now automatically runs CI.

Latest intentional push-CI trigger: 2026-07-09.

## Push CI behavior

Every push to `master` affecting these files runs a safe CI diagnostic:

- `data/fleet_erp_updates.json`
- `scripts/frappe_erp_git_task_sync.mjs`
- `scripts/validate_fleet_erp_updates.mjs`
- `.github/workflows/erp-task-sync.yml`
- `docs/ERP_FLEET_TASK_SYNC.md`
- `package.json`

Push CI does **not** create or update ERP tasks. It runs with:

```text
DRY_RUN=1
```

That means it validates:

- JSON payload correctness
- completed task timeline structure
- ERP login using the working cookie pattern from `worker.js`
- Project lookup/read access
- Task lookup/read access
- duplicate-safe create/update plan

If push CI fails, the Actions log should identify the root cause, such as:

- missing GitHub Secrets
- ERP login failed
- missing `sid` cookie
- missing `frappe_csrf_token` cookie
- Project not found
- Project read permission missing
- Task read permission missing

## Manual ERP write behavior

To actually create/update tasks in ERP, manually run the GitHub Actions workflow:

```text
ERP Fleet Task Sync
```

Use:

```text
mode = sync_to_erp
```

Only use this when you want to print the plan without writing to ERP:

```text
mode = validate_only
```

## What it does

- Validates and prints the task payload from `data/fleet_erp_updates.json`.
- Logs in to ERP through `/api/method/login` using the same cookie pattern as `worker.js`.
- Reads `sid` and `frappe_csrf_token` from login response cookies.
- Sends `Cookie: sid=...` and `X-Frappe-CSRF-Token` for state-changing Frappe requests.
- Validates or discovers the ERP `Project` record.
- Creates or updates tasks, avoiding duplicates by checking same `project + subject` first.

## Files

- `.github/workflows/erp-task-sync.yml` — push CI diagnostic + manual ERP sync workflow.
- `scripts/frappe_erp_git_task_sync.mjs` — direct Frappe REST sync script.
- `scripts/validate_fleet_erp_updates.mjs` — JSON/task payload validator.
- `data/fleet_erp_updates.json` — stable update payload. Edit this file in future.

## Required GitHub Secrets

Add these in repository settings:

- `ERP_USERNAME`
- `ERP_PASSWORD`

Recommended optional secrets:

- `ERP_URL` — default is handled by script as `https://erp.hippoclouds.com` if omitted.
- `ERP_PROJECT` — exact ERP Project document name if known.

Do not commit PATs, ERP usernames, ERP passwords, cookies, session IDs, or API tokens into repository files.

## How to update tasks in future

Open `data/fleet_erp_updates.json` and update these sections:

### 1. Update source metadata

```json
"lastUpdatedAsiaKolkata": "YYYY-MM-DD",
"latestObservedCommit": "latest_commit_sha"
```

### 2. Update daily summary

Change:

```json
"dailySummaryTask": {
  "subject": "Daily Git Timeline Update - Fleet Management - YYYY-MM-DD",
  "status": "Open",
  "priority": "High",
  "description": "What completed, what failed, what is next."
}
```

### 3. Add completed work

Add a new object under `completedTasks`:

```json
{
  "subject": "Short completed task name",
  "status": "Completed",
  "priority": "High",
  "branch": "branch-name",
  "pr": 42,
  "from": "2026-07-08T10:00:00Z",
  "to": "2026-07-08T12:00:00Z",
  "description": "What changed and what evidence exists."
}
```

### 4. Add or update next tasks

Add open items under `nextTasks`:

```json
{
  "subject": "Next task name",
  "status": "Open",
  "priority": "High",
  "description": "Exact next action and blocking condition."
}
```

## Run from GitHub Actions

1. Go to **Actions**.
2. Open **ERP Fleet Task Sync**.
3. Choose **Run workflow**.
4. Select `mode = sync_to_erp` to create/update tasks.
5. Select `mode = validate_only` only when you want validation without ERP writes.

## Run locally

```bash
export ERP_URL="https://erp.hippoclouds.com"
export ERP_USER="your-erp-username"
read -s -p "ERP Password: " ERP_PASS
echo
export ERP_PASS
export ERP_PROJECT="FLEET-MANAGEMENT"
export INPUT_FILE="data/fleet_erp_updates.json"

DRY_RUN=1 node scripts/frappe_erp_git_task_sync.mjs
DRY_RUN=0 node scripts/frappe_erp_git_task_sync.mjs
```

## Current payload

The current stable payload contains:

- 1 daily summary task
- 14 completed timeline tasks
- 3 next/risk tasks

These are based on Fleet Management GitHub PR and commit history up to 2026-07-08.
