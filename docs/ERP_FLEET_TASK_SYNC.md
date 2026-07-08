# ERP Fleet Task Sync

This workflow creates or updates Frappe/ERPNext `Task` records from the Fleet Management Git timeline payload.

## What it does

- Logs in to `https://erp.hippoclouds.com` through `/api/method/login`.
- Validates or discovers the ERP `Project` record.
- Upserts tasks from `data/fleet_git_tasks_2026-07-08.json`.
- Avoids duplicate tasks by checking same `project + subject` first.
- Supports dry-run mode before writing to ERP.

## Files

- `.github/workflows/erp-task-sync.yml` — manual GitHub Actions workflow.
- `scripts/frappe_erp_git_task_sync.mjs` — direct Frappe REST sync script.
- `data/fleet_git_tasks_2026-07-08.json` — generated task payload from GitHub branch/PR timeline.

## Required GitHub Secrets

Add these in repository settings:

- `ERP_USERNAME`
- `ERP_PASSWORD`

Recommended optional secrets:

- `ERP_URL` — default is handled by script as `https://erp.hippoclouds.com` if omitted.
- `ERP_PROJECT` — exact ERP Project document name if known.

Do not commit PATs, ERP usernames, ERP passwords, cookies, session IDs, or API tokens into repository files.

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
export INPUT_FILE="data/fleet_git_tasks_2026-07-08.json"

DRY_RUN=1 node scripts/frappe_erp_git_task_sync.mjs
DRY_RUN=0 node scripts/frappe_erp_git_task_sync.mjs
```

## Current payload

The current payload contains:

- 1 daily summary task
- 13 completed timeline tasks
- 3 next/risk tasks

These are based on Fleet Management GitHub PR and commit history up to 2026-07-08.
