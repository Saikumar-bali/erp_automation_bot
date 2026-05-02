export default {
  // 1. AUTOMATED CRON JOB
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log("Scheduled Trigger Started");
      const istDate = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
      
      try {
        // 1. Sync Holidays once a day at 10 AM
        if (istDate.getHours() === 10) {
          console.log("Morning Run: Auto-Syncing Holidays...");
          await syncHolidays(env);
        }
        
        // 2. Process Attendance
        const report = await handleAttendanceFlow(env);
        console.log("Attendance Flow Finished: " + report);
      } catch (e) {
        console.error("CRITICAL CRON ERROR: " + e.message);
        const today = istDate.getFullYear() + '-' + String(istDate.getMonth() + 1).padStart(2, '0') + '-' + String(istDate.getDate()).padStart(2, '0');
        await env.ATT_DB.put(`LOG:\${today}`, "CRON FAILED: " + e.message);
      }
    })());
  },

  // 2. WEB INTERFACE & API
  async fetch(request, env) {
    const url = new URL(request.url);
    const pwd = url.searchParams.get('pwd');

    if (pwd !== env.DASHBOARD_PWD) {
      return new Response("Unauthorized. Use ?pwd=YourPassword", { status: 401 });
    }

    // API: Fetch Execution Logs
    if (url.pathname === "/api/logs") {
      const keys = await env.ATT_DB.list({ prefix: "LOG:" });
      const logs = {};
      for (const key of keys.keys) {
        logs[key.name] = await env.ATT_DB.get(key.name);
      }
      return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
    }

    // API: Fetch All Calendar & Log Data
    if (url.pathname === "/api/data") {
      const keys = await env.ATT_DB.list();
      const data = {};
      for (const key of keys.keys) {
        data[key.name] = await env.ATT_DB.get(key.name);
      }
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }

    // API: Update Date Status (Manual Override)
    if (url.pathname === "/api/update" && request.method === "POST") {
      const { date, status } = await request.json();
      await env.ATT_DB.put(`PLAN:${date}`, status);
      return new Response(JSON.stringify({ success: true }));
    }

    // API: Sync Holidays from ERP
    if (url.pathname === "/api/sync-holidays") {
      try {
        const result = await syncHolidays(env);
        return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
      }
    }

    // API: Manual Punch Trigger
    if (url.pathname === "/api/punch") {
      try {
        const report = await handleAttendanceFlow(env);
        return new Response(report);
      } catch (e) {
        return new Response("ERROR: " + e.message, { status: 500 });
      }
    }

    // Serve Monthly Dashboard
    return new Response(renderMonthlyDashboard(pwd), {
      headers: { "Content-Type": "text/html" }
    });
  }
};

async function handleAttendanceFlow(env) {
  const istDate = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
  const today = istDate.toISOString().split('T')[0];

  // Logic Priority:
  // 1. Manual PLAN override (WORK/LEAVE)
  // 2. ERP HOLIDAY list
  // 3. Default (Punch)

  const manualPlan = await env.ATT_DB.get(`PLAN:${today}`);
  const isEphHoliday = await env.ATT_DB.get(`HOLIDAY:${today}`);

  if (manualPlan === "LEAVE") {
    await env.ATT_DB.put(`LOG:${today}`, "SKIPPED: MANUAL LEAVE");
    return `[${today}] SKIPPED: Manual Leave.`;
  }

  if (manualPlan !== "WORK" && isEphHoliday) {
    await env.ATT_DB.put(`LOG:${today}`, `SKIPPED: ERP HOLIDAY (${isEphHoliday})`);
    return `[${today}] SKIPPED: ERP Holiday (${isEphHoliday}).`;
  }

  // Proceed with Punch
  const resultReport = await runAttendance(env, istDate);
  const status = resultReport.includes("SUCCESS") ? "SUCCESS" : "FAILED";
  const summary = resultReport.split('\n').find(line => line.includes("SUCCESS") || line.includes("FAILED")) || resultReport;
  await env.ATT_DB.put(`LOG:${today}`, `${status}: ${summary}`);
  
  return resultReport;
}

async function syncHolidays(env) {
  const config = JSON.parse(env.CONFIG);
  const baseUrl = config.login_url.split('/login')[0];
  const user = config.users[0];

  // Login
  const loginRes = await fetch(`${baseUrl}/api/method/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usr: user.username, pwd: user.password })
  });
  const cookies = loginRes.headers.get('set-cookie') || '';
  const sid = cookies.match(/sid=([^;]+)/)?.[1];
  if (!sid) throw new Error("Sync failed: Authentication error.");

  // Fetch Holidays (Current Month +/- 2 Months)
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10) + " 00:00:00";
  const end = new Date(d.getFullYear(), d.getMonth() + 3, 0).toISOString().slice(0, 10) + " 23:59:59";

  const holidayUrl = new URL(`${baseUrl}/api/method/erpnext.setup.doctype.holiday_list.holiday_list.get_events`);
  holidayUrl.searchParams.set('doctype', 'Holiday List');
  holidayUrl.searchParams.set('start', start);
  holidayUrl.searchParams.set('end', end);
  holidayUrl.searchParams.set('field_map', JSON.stringify({"start":"holiday_date","end":"holiday_date","id":"name","title":"description","allDay":"allDay"}));

  const res = await fetch(holidayUrl, { headers: { 'Cookie': `sid=${sid}` } });
  const data = await res.json();
  const holidays = data.message || [];
  
  // Clear existing holidays first to ensure a clean sync
  const existingKeys = await env.ATT_DB.list({ prefix: "HOLIDAY:" });
  for (const key of existingKeys.keys) {
    await env.ATT_DB.delete(key.name);
  }

  let count = 0;
  for (const h of holidays) {
    const date = h.start || h.holiday_date;
    let desc = h.title || h.description || "Holiday";
    const listName = h.id || h.name || "";

    // Filter: Only include "Holiday List -2026" and ignore "Tally Care"
    if (listName.includes("Tally Care")) continue;
    
    if (date) {
      // Clean HTML from description if present
      desc = desc.replace(/<[^>]*>?/gm, '').trim();
      
      const dateKey = date.split(' ')[0]; 
      await env.ATT_DB.put(`HOLIDAY:${dateKey}`, desc);
      count++;
    }
  }
  return { success: true, count: count };
}

async function runAttendance(env, istDate) {
  const config = JSON.parse(env.CONFIG);
  const hour = istDate.getHours();
  const logType = hour < 14 ? 'IN' : 'OUT'; 
  const baseUrl = config.login_url.split('/login')[0];
  let report = `--- Punch Report (${istDate.toISOString()}) ---\n`;

  for (const user of config.users) {
    try {
      const loginRes = await fetch(`${baseUrl}/api/method/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ usr: user.username, pwd: user.password })
      });
      const setCookie = loginRes.headers.get('set-cookie') || '';
      const sid = setCookie.match(/sid=([^;]+)/)?.[1];
      const csrfToken = setCookie.match(/frappe_csrf_token=([^;]+)/)?.[1];

      if (!sid) {
        const errorData = await loginRes.json().catch(() => ({}));
        report += `FAILED: ${user.username} (Login failed: ${JSON.stringify(errorData)})\n`;
        continue;
      }

      const timestamp = istDate.toISOString().slice(0, 19).replace('T', ' ');
      const response = await fetch(`${baseUrl}/api/resource/Employee Checkin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `sid=${sid}`,
          'X-Frappe-CSRF-Token': csrfToken || ''
        },
        body: JSON.stringify({
          log_type: logType,
          time: timestamp,
          device_id: "Cloudflare_Worker_Pro",
          latitude: config.latitude,
          longitude: config.longitude
        })
      });

      const result = await response.json();
      if (response.ok) {
        report += `SUCCESS: ${user.username} ${logType} [ID: ${result.data?.name}]\n`;
      } else {
        report += `FAILED: ${user.username} (API Error: ${JSON.stringify(result)})\n`;
      }
    } catch (e) {
      report += `ERROR: ${user.username} (${e.message})\n`;
    }
  }
  return report;
}

function renderMonthlyDashboard(pwd) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Attendance Pro Calendar</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap');
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .day-cell { min-height: 90px; transition: all 0.2s; position: relative; }
        .dot { height: 6px; width: 6px; border-radius: 50%; display: inline-block; margin: 2px; }
        .dot-success { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
        .dot-leave { background: #ef4444; }
        .dot-holiday { background: #3b82f6; }
        .dot-failed { background: #f59e0b; }
    </style>
</head>
<body class="p-2 md:p-10 min-h-screen">
    <div class="max-w-4xl mx-auto">
        <!-- Header -->
        <div class="flex items-center justify-between mb-6 px-2">
            <div>
                <h1 class="text-2xl font-600 tracking-tight">Attendance Bot</h1>
                <p id="current-month-display" class="text-blue-400 font-semibold"></p>
            </div>
            <div class="flex space-x-2">
                <button onclick="changeMonth(-1)" class="p-2 glass rounded-lg hover:bg-slate-700"><i class="fas fa-chevron-left"></i></button>
                <button onclick="syncHolidays()" class="p-2 glass rounded-lg hover:bg-slate-700 text-blue-400" title="Sync ERP Holidays"><i class="fas fa-sync-alt"></i></button>
                <button onclick="changeMonth(1)" class="p-2 glass rounded-lg hover:bg-slate-700"><i class="fas fa-chevron-right"></i></button>
            </div>
        </div>

        <!-- Legend -->
        <div class="flex flex-wrap gap-4 mb-6 px-2 text-[10px] uppercase tracking-widest text-slate-500">
            <div class="flex items-center"><span class="dot dot-success mr-2"></span> Punched</div>
            <div class="flex items-center"><span class="dot dot-holiday mr-2"></span> ERP Holiday</div>
            <div class="flex items-center"><span class="dot dot-leave mr-2"></span> Manual Skip</div>
        </div>

        <!-- Calendar -->
        <div class="glass rounded-3xl overflow-hidden shadow-2xl mb-8">
            <div class="grid grid-cols-7 bg-slate-800/80 border-b border-slate-700">
                ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="py-3 text-center text-[10px] font-bold text-slate-400 uppercase tracking-tighter">${d}</div>`).join('')}
            </div>
            <div id="calendar-grid" class="grid grid-cols-7"></div>
        </div>

        <!-- Execution Logs -->
        <div class="glass rounded-3xl p-6 mb-8">
            <h2 class="text-slate-400 text-xs uppercase tracking-widest mb-4">Execution Logs</h2>
            <div id="logs-container" class="space-y-2 text-[10px] font-mono max-h-40 overflow-y-auto">
                <div class="text-slate-600 italic">Loading logs...</div>
            </div>
        </div>

        <!-- Actions -->
        <div class="mt-8 grid grid-cols-2 gap-4">
            <button onclick="testPunch()" class="py-4 glass rounded-2xl hover:bg-slate-800 transition-all flex items-center justify-center space-x-3 text-blue-400">
                <i class="fas fa-fingerprint"></i>
                <span>Force Punch</span>
            </button>
            <button onclick="init()" class="py-4 glass rounded-2xl hover:bg-slate-800 transition-all flex items-center justify-center space-x-3 text-slate-400">
                <i class="fas fa-redo"></i>
                <span>Refresh</span>
            </button>
        </div>
    </div>

    <script>
        const PWD = "${pwd}";
        let currentViewDate = new Date();
        let kvData = {};

        async function init() {
            const [dataRes, logsRes] = await Promise.all([
                fetch('/api/data?pwd=' + PWD),
                fetch('/api/logs?pwd=' + PWD)
            ]);
            kvData = await dataRes.json();
            const logs = await logsRes.json();
            
            render();
            renderLogs(logs);
        }

        function renderLogs(logs) {
            const container = document.getElementById('logs-container');
            container.innerHTML = '';
            const sortedKeys = Object.keys(logs).sort().reverse();
            
            if (sortedKeys.length === 0) {
                container.innerHTML = '<div class="text-slate-600 italic">No execution logs found.</div>';
                return;
            }

            sortedKeys.forEach(key => {
                const date = key.replace('LOG:', '');
                const text = logs[key];
                const isSuccess = text.includes('SUCCESS');
                const isSkip = text.includes('SKIPPED');
                
                const item = document.createElement('div');
                item.className = "flex space-x-2 border-l-2 pl-2 " + (isSuccess ? "border-green-500" : isSkip ? "border-blue-500" : "border-red-500");
                item.innerHTML = \`<span class="text-slate-500">\${date}:</span> <span class="\${isSuccess ? 'text-green-400' : isSkip ? 'text-blue-400' : 'text-red-400'}">\${text}</span>\`;
                container.appendChild(item);
            });
        }

        async function syncHolidays() {
            if(!confirm("Sync holidays from ERP?")) return;
            const res = await fetch('/api/sync-holidays?pwd=' + PWD);
            const result = await res.json();
            alert(result.success ? "Successfully synced " + result.count + " holidays!" : "Error: " + result.error);
            init();
        }

        async function toggleMode(dateStr) {
            const currentPlan = kvData['PLAN:' + dateStr];
            const isHoliday = kvData['HOLIDAY:' + dateStr];
            
            let next;
            // Cycle logic: Default -> LEAVE -> WORK -> Default
            if (!currentPlan) next = "LEAVE";
            else if (currentPlan === "LEAVE") next = "WORK";
            else next = ""; // Reset to default

            kvData['PLAN:' + dateStr] = next;
            render();

            await fetch('/api/update?pwd=' + PWD, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: dateStr, status: next })
            });
        }

        function render() {
            const grid = document.getElementById('calendar-grid');
            const monthDisplay = document.getElementById('current-month-display');
            grid.innerHTML = '';
            const year = currentViewDate.getFullYear();
            const month = currentViewDate.getMonth();
            monthDisplay.innerText = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(currentViewDate);
            
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();

            for (let i = 0; i < firstDay; i++) grid.innerHTML += '<div class="day-cell border-r border-b border-slate-700/30 bg-slate-900/10"></div>';

            for (let day = 1; day <= daysInMonth; day++) {
                // Correctly format dateStr WITHOUT UTC shift
                const dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
                const isToday = new Date().toISOString().split('T')[0] === dateStr;
                
                const plan = kvData['PLAN:' + dateStr];
                const holiday = kvData['HOLIDAY:' + dateStr];
                const log = kvData['LOG:' + dateStr];

                const isLeave = plan === "LEAVE";
                const isWork = plan === "WORK";
                const isPunched = log && log.startsWith("SUCCESS");

                grid.innerHTML += \`
                    <div onclick="toggleMode('\${dateStr}')" 
                        class="day-cell border-r border-b border-slate-700/30 p-2 cursor-pointer hover:bg-slate-800/40 \${isToday ? 'bg-blue-500/5' : ''}">
                        <span class="text-xs \${isToday ? 'text-blue-400 font-bold' : 'text-slate-500'}">\${day}</span>
                        <div class="mt-1 flex flex-wrap">
                            \${holiday ? '<span class="dot dot-holiday" title="\${holiday}"></span>' : ''}
                            \${isLeave ? '<span class="dot dot-leave"></span>' : ''}
                            \${isWork ? '<span class="dot dot-success"></span>' : ''}
                            \${isPunched ? '<span class="dot dot-success shadow-lg shadow-green-500"></span>' : ''}
                        </div>
                        <div class="text-[8px] mt-1 truncate uppercase font-bold">
                            \${isWork ? '<span class="text-green-500">Manual Work</span>' : ''}
                            \${isLeave ? '<span class="text-red-500">Manual Skip</span>' : ''}
                            \${(!plan && holiday) ? \`<span class="text-blue-500">\${holiday}</span>\` : ''}
                        </div>
                    </div>\`;
            }
        }
        function changeMonth(delta) { currentViewDate.setMonth(currentViewDate.getMonth() + delta); render(); }
        async function testPunch() { if(confirm("Force punch now?")) { const r = await fetch('/api/punch?pwd=' + PWD); alert(await r.text()); init(); } }
        init();
    </script>
</body>
</html>
  `;
}
