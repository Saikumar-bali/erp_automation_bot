# ERP Fleet Task Sync

This workflow creates or updates Frappe/ERPNext `Task` records from one stable Fleet Management update file.

## Daily rule

In future, update only this file when work is completed or next work changes:

```text
data/fleet_erp_updates.json
```

Then manually run the GitHub Actions workflow:

```text
ERP Fleet Task Sync
```

Start with `dry_run = 1`. If the output is correct, run again with `dry_run = 0`.

## What it does

- Logs in to the ERP through `/api/method/login`.
- Validates or discovers the ERP `Project` record.
- Upserts tasks from `data/fleet_erp_updates.json`.
- Avoids duplicate tasks by checking same `project + subject` first.
- Supports dry-run mode before writing to ERP.

## Files

- `.github/workflows/erp-task-sync.yml` — manual GitHub Actions workflow.
- `scripts/frappe_erp_git_task_sync.mjs` — direct Frappe REST sync script.
- `data/fleet_erp_updates.json` — stable update payload. Edit this file in future.
- `data/fleet_git_tasks_2026-07-08.json` — archived/generated first payload kept for reference.

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
"latestObservedCommit": "latest_commit_sha",
"latestObservedCommitMessage": "latest commit message"
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
4. Start with `dry_run = 1`.
5. If the output shows the correct project and tasks, run again with `dry_run = 0`.

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
