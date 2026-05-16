# Hippo ERP Bot - Precision Attendance Automation

A professional-grade attendance automation suite for the Hippo ERP system (hippoclouds.com). This project provides sub-second punch accuracy using a dual-layer architecture: **Cloudflare Workers** (Primary) and **GitHub Actions** (Secondary/Backup).

## 🏆 Core Architecture

### 1. Primary Method: Cloudflare Worker (Ultra-Fast API)
The primary engine is a serverless Cloudflare Worker that uses the "Precision Sniper" strategy.
- **Method**: Direct REST API interaction (no browser overhead).
- **Accuracy**: Sub-second precision (aims for exactly 10:00:00.000).
- **Pre-Warm Logic**: Wakes up 1 minute early to pre-authenticate, eliminating login latency.
- **Dashboard**: Includes a built-in web dashboard to manage work plans and view logs.

### 2. Secondary Method: GitHub Actions (Browser-Based)
A reliable backup using Playwright to simulate a real user interaction.
- **Method**: Headless Chromium browser via Python.
- **Fallback**: Used if the API is restricted or for generating visual proof (screenshots).
- **Automated**: Runs on GitHub-hosted runners with secure secret management.

---

## ✨ Features

- **Precision Sniper**: Hits the punch target within milliseconds of the scheduled time.
- **Smart Scheduling**: Automatically follows IST (Indian Standard Time) regardless of server location.
- **Live Dashboard**: A sleek, glassmorphic UI to toggle between "WORK" and "LEAVE" modes.
- **Holiday Awareness**: Automatically syncs with the ERP's holiday list.
- **Multi-User Support**: Processes multiple employee accounts in parallel.
- **Geolocation Spoofing**: Satisfies location-based requirements via coordinates.

---

## 🚀 Quick Start (Cloudflare Primary)

### 1. Deploy the Worker
1. Install Wrangler: `npm install -g wrangler`
2. Update `wrangler.toml` with your KV namespace ID.
3. Deploy: `npx wrangler deploy`

### 2. Configure Environment Variables
In the Cloudflare Dashboard (or via `wrangler secret`), set:
- `CONFIG`: A JSON string containing user credentials and coordinates.
- `DASHBOARD_PWD`: Your secret password for the web UI.

### 3. Set Cron Triggers
Set the triggers to fire **1 minute early** to allow for pre-authentication:
- `29 4 * * MON-SAT` (09:59 AM IST)
- `29 13 * * MON-SAT` (06:59 PM IST)

---

## 🛠️ Secondary Method (GitHub Actions)

If you prefer browser-based automation or need screenshots:
1. Fork this repository.
2. Add the following **Secrets** to your repository:
   - `ERP_USERNAME`, `ERP_PASSWORD`, `ERP_LOGIN_URL`, `LATITUDE`, `LONGITUDE`.
3. Enable the "Scheduled Attendance Automation" workflow.

---

## 📁 Project Structure

```
Hippo_erp_bot/
├── worker.js              # Primary Cloudflare Worker (API + Dashboard)
├── wrangler.toml          # Cloudflare configuration
├── src/
│   └── auto_attendance.py # Secondary Python script (Browser-based)
├── attendance.js          # Local Node.js automation (Puppeteer)
├── WORKFLOW.md            # Detailed technical documentation
└── .github/workflows/     # GitHub Actions CI/CD
```

---

## 📊 Monitoring

- **Web Dashboard**: Access `https://your-worker.workers.dev/?pwd=YOUR_PWD` to see the calendar and logs.
- **Execution Logs**: View detailed logs including millisecond-level punch confirmation:
  `SUCCESS: User1 IN @ 2026-05-16 10:00:00.005`

---

## ⚠️ Disclaimer

This tool is for educational purposes. Users are responsible for ensuring compliance with their employer's policies. The authors are not responsible for any misuse or consequences resulting from the use of this bot.

---
*Developed for maximum efficiency and sub-second precision.*
