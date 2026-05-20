function getIstDate() {
  return new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
}

export default {
  // 1. AUTOMATED CRON JOB
  async scheduled(event, env, ctx) {
    const istDate = getIstDate();
    const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const today = istDate.toISOString().split('T')[0];
    
    ctx.waitUntil((async () => {
      try {
        const startIstStr = istDate.toISOString().replace('T', ' ').slice(0, 23);
        const dayLabel = dayNames[istDate.getDay()]; // Local day in IST
        
        // Initial log to prove the cron fired
        await env.ATT_DB.put(`LOG:${today}`, `CRON TRIGGERED: ${dayLabel} at ${startIstStr}`);
        
        // Ensure CONFIG exists
        if (!env.CONFIG) throw new Error("Environment variable 'CONFIG' is missing.");

        const report = await handleAttendanceFlow(env);
        
        // Sync holidays on every run to be safe, or at least once a day
        await syncHolidays(env);
        
      } catch (e) {
        const errDate = getIstDate().toISOString().split('T')[0];
        const existing = await env.ATT_DB.get(`LOG:${errDate}`) || "";
        await env.ATT_DB.put(`LOG:${errDate}`, `${existing} | CRON FATAL: ${e.message}`);
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const pwd = url.searchParams.get('pwd');
    if (pwd !== env.DASHBOARD_PWD) return new Response("Unauthorized.", { status: 401 });

    if (url.pathname === "/api/logs") {
      const keys = await env.ATT_DB.list({ prefix: "LOG:" });
      const logs = {};
      for (const k of keys.keys) logs[k.name] = await env.ATT_DB.get(k.name) || "";
      return new Response(JSON.stringify(logs), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/data") {
      const keys = await env.ATT_DB.list();
      const data = {};
      for (const k of keys.keys) data[k.name] = await env.ATT_DB.get(k.name) || "";
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/update" && request.method === "POST") {
      const { date, status } = await request.json();
      await env.ATT_DB.put(`PLAN:${date}`, status);
      return new Response(JSON.stringify({ success: true }));
    }

    if (url.pathname === "/api/sync-holidays") {
      try {
        const result = await syncHolidays(env);
        return new Response(JSON.stringify(result));
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
      }
    }

    if (url.pathname === "/api/punch") {
      try {
        const report = await handleAttendanceFlow(env);
        return new Response(report);
      } catch (e) {
        return new Response("ERROR: " + e.message, { status: 500 });
      }
    }

    return new Response(renderMonthlyDashboard(pwd), { headers: { "Content-Type": "text/html" } });
  }
};

async function handleAttendanceFlow(env) {
  const istDate = getIstDate();
  const today = istDate.toISOString().split('T')[0];
  const manualPlan = await env.ATT_DB.get(`PLAN:${today}`);
  const isEphHoliday = await env.ATT_DB.get(`HOLIDAY:${today}`);

  if (manualPlan === "LEAVE") {
    await env.ATT_DB.put(`LOG:${today}`, "SKIPPED: MANUAL LEAVE");
    return "SKIPPED: MANUAL LEAVE";
  }

  if (manualPlan !== "WORK" && isEphHoliday) {
    await env.ATT_DB.put(`LOG:${today}`, `SKIPPED: ERP HOLIDAY (${isEphHoliday})`);
    return `SKIPPED: ERP HOLIDAY (${isEphHoliday})`;
  }

  const resultReport = await runAttendance(env, istDate);
  const status = resultReport.includes("SUCCESS") ? "SUCCESS" : "FAILED";
  const summary = resultReport.split('\n').find(l => l.includes("SUCCESS") || l.includes("FAILED")) || "Done";
  
  const existingLogs = await env.ATT_DB.get(`LOG:${today}`) || "";
  await env.ATT_DB.put(`LOG:${today}`, `${existingLogs} | ${status}: ${summary}`);
  return resultReport;
}

async function syncHolidays(env) {
  if (!env.CONFIG) return { success: false, error: "Missing CONFIG" };
  const config = JSON.parse(env.CONFIG);
  const baseUrl = config.login_url.split('/login')[0];
  const user = config.users[0];
  
  try {
    const loginRes = await fetch(`${baseUrl}/api/method/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ usr: user.username, pwd: user.password })
    });
    const sid = (loginRes.headers.get('set-cookie') || '').match(/sid=([^;]+)/)?.[1];
    if (!sid) return { success: false, error: "Auth failed for holiday sync" };

    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10) + " 00:00:00";
    const end = new Date(d.getFullYear(), d.getMonth() + 3, 0).toISOString().slice(0, 10) + " 23:59:59";
    
    const res = await fetch(`${baseUrl}/api/method/erpnext.setup.doctype.holiday_list.holiday_list.get_events?doctype=Holiday%20List&start=${start}&end=${end}&field_map=${encodeURIComponent(JSON.stringify({"start":"holiday_date","end":"holiday_date","id":"name","title":"description"}))}`, {
      headers: { 'Cookie': `sid=${sid}` }
    });
    
    const holidays = (await res.json()).message || [];
    if (!Array.isArray(holidays)) return { success: false, error: "Invalid holiday response" };

    const puts = [];
    for (const h of holidays) {
      const date = h.start || h.holiday_date;
      if (!date) continue;
      const dateStr = date.split(' ')[0];
      const desc = (h.title || "Holiday").replace(/<[^>]*>?/gm, '').trim();
      puts.push(env.ATT_DB.put(`HOLIDAY:${dateStr}`, desc));
    }
    await Promise.all(puts);
    return { success: true, count: puts.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function runAttendance(env, istDate) {
  if (!env.CONFIG) throw new Error("Environment variable 'CONFIG' is missing.");
  const config = JSON.parse(env.CONFIG);
  const logType = istDate.getHours() < 14 ? 'IN' : 'OUT'; 
  const baseUrl = config.login_url.split('/login')[0];

  // 1. PRE-AUTHENTICATION
  const authResults = await Promise.all(config.users.map(async (user) => {
    try {
      const loginRes = await fetch(`${baseUrl}/api/method/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ usr: user.username, pwd: user.password })
      });
      const sid = (loginRes.headers.get('set-cookie') || '').match(/sid=([^;]+)/)?.[1];
      const csrfToken = (loginRes.headers.get('set-cookie') || '').match(/frappe_csrf_token=([^;]+)/)?.[1];
      return { username: user.username, sid, csrfToken, error: sid ? null : 'Auth failed' };
    } catch (e) {
      return { username: user.username, error: e.message };
    }
  }));

  // 2. PRECISION WAIT (Targeting exact UTC seconds)
  const targetHourUtc = logType === 'IN' ? 4 : 13;
  const targetMinUtc = 30;
  
  const targetTime = new Date();
  targetTime.setUTCHours(targetHourUtc, targetMinUtc, 0, 0);
  const targetMs = targetTime.getTime();

  // Wait only if we triggered early (limit to 5s to avoid worker timeout)
  if (Date.now() < targetMs) {
    const waitLimit = 5000;
    const startWait = Date.now();
    while (Date.now() < targetMs && (Date.now() - startWait) < waitLimit) {
      const remaining = targetMs - Date.now();
      if (remaining <= 0) break;
      const sleep = Math.min(remaining, 500);
      await new Promise(r => setTimeout(r, sleep));
    }
  }

  const startTime = Date.now();
  const offset = 5.5 * 60 * 60 * 1000;
  
  // 3. EXECUTE PUNCHES
  const userResults = await Promise.all(authResults.map(async (auth) => {
    if (auth.error) return `FAILED: ${auth.username} (${auth.error})`;
    try {
      const hash = auth.username.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0);
      const stableDeviceId = 'mobile_' + Math.abs(hash).toString(16).padEnd(12, 'a');
      const nowIst = new Date(Date.now() + offset);
      const punchTime = nowIst.toISOString().slice(0, 19).replace('T', ' ');
      const punchMs = String(nowIst.getMilliseconds()).padStart(3, '0');
      
      const response = await fetch(`${baseUrl}/api/resource/Employee Checkin`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Cookie': `sid=${auth.sid}`, 
          'X-Frappe-CSRF-Token': auth.csrfToken || '' 
        },
        body: JSON.stringify({ 
          log_type: logType, 
          time: punchTime, 
          device_id: stableDeviceId, 
          latitude: config.latitude, 
          longitude: config.longitude, 
          custom_office_location: "Ramatalkies", 
          location_id: stableDeviceId 
        })
      });
      const resData = await response.json();
      return response.ok ? `SUCCESS: ${auth.username} ${logType} @ ${punchTime}.${punchMs}` : `FAILED: ${auth.username} (${resData.exception || 'API Error'})`;
    } catch (e) { return `ERROR: ${auth.username} (${e.message})`; }
  }));
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(3);
  return `--- Precision Punch Report --- \nDuration: ${duration}s\n` + userResults.join('\n');
}

function renderMonthlyDashboard(pwd) {
  const daysHeader = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="py-3 text-center text-[10px] font-bold text-slate-400 uppercase">${d}</div>`).join('');
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Attendance Bot</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap');
        body { font-family: 'Inter', sans-serif; background: #0f172a; color: #f8fafc; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .day-cell { min-height: 80px; transition: all 0.2s; position: relative; }
        .dot { height: 6px; width: 6px; border-radius: 50%; display: inline-block; margin: 2px; }
        .dot-success { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
        .dot-leave { background: #ef4444; }
        .dot-holiday { background: #3b82f6; }
    </style>
</head>
<body class="p-2 md:p-8 min-h-screen">
    <div class="max-w-4xl mx-auto">
        <div class="flex items-center justify-between mb-6 px-2">
            <div><h1 class="text-2xl font-bold">Attendance Bot</h1><p id="current-month-display" class="text-blue-400 font-semibold"></p></div>
            <div class="flex space-x-2">
                <button onclick="changeMonth(-1)" class="p-2 glass rounded-lg"><i class="fas fa-chevron-left"></i></button>
                <button onclick="syncHolidays()" class="p-2 glass rounded-lg text-blue-400"><i class="fas fa-sync-alt"></i></button>
                <button onclick="changeMonth(1)" class="p-2 glass rounded-lg"><i class="fas fa-chevron-right"></i></button>
            </div>
        </div>
        <div class="glass rounded-3xl overflow-hidden mb-8">
            <div class="grid grid-cols-7 bg-slate-800/80 border-b border-slate-700">${daysHeader}</div>
            <div id="calendar-grid" class="grid grid-cols-7"></div>
        </div>
        <div class="glass rounded-3xl p-6 mb-8">
            <h2 class="text-slate-400 text-xs uppercase mb-4">Execution Logs</h2>
            <div id="logs-container" class="space-y-2 text-[10px] font-mono max-h-60 overflow-y-auto"></div>
        </div>
        <div class="grid grid-cols-2 gap-4">
            <button onclick="testPunch()" class="py-4 glass rounded-2xl text-blue-400 flex items-center justify-center space-x-3"><i class="fas fa-fingerprint"></i><span>Force Punch</span></button>
            <button onclick="init()" class="py-4 glass rounded-2xl text-slate-400 flex items-center justify-center space-x-3"><i class="fas fa-redo"></i><span>Refresh</span></button>
        </div>
    </div>
    <script>
        const PWD = "${pwd}";
        let currentViewDate = new Date();
        let kvData = {};
        async function init() {
            try {
                const [dataRes, logsRes] = await Promise.all([fetch('/api/data?pwd='+PWD), fetch('/api/logs?pwd='+PWD)]);
                kvData = await dataRes.json();
                render();
                renderLogs(await logsRes.json());
            } catch(e) { console.error(e); }
        }
        function renderLogs(logs) {
            const c = document.getElementById('logs-container'); c.innerHTML = '';
            Object.keys(logs).sort().reverse().forEach(k => {
                const t = logs[k]; const isS = t.includes('SUCCESS'), isL = t.includes('SKIPPED');
                const d = document.createElement('div');
                d.className = "border-l-2 pl-2 " + (isS?"border-green-500":isL?"border-blue-500":"border-red-500");
                d.innerHTML = \`<span class="text-slate-500">\${k.replace('LOG:','')}:</span> <span class="\${isS?'text-green-400':isL?'text-blue-400':'text-red-400'}">\${t}</span>\`;
                c.appendChild(d);
            });
        }
        async function syncHolidays() { const res = await fetch('/api/sync-holidays?pwd='+PWD); const r = await res.json(); alert(r.success?"Synced":"Error"); init(); }
        async function toggleMode(dateStr) {
            const p = kvData['PLAN:'+dateStr];
            let n = !p ? "LEAVE" : (p==="LEAVE" ? "WORK" : "");
            await fetch('/api/update?pwd='+PWD, { method: 'POST', body: JSON.stringify({date:dateStr, status:n}) });
            init();
        }
        function render() {
            const g = document.getElementById('calendar-grid'), dsp = document.getElementById('current-month-display');
            g.innerHTML = '';
            const y = currentViewDate.getFullYear(), m = currentViewDate.getMonth();
            dsp.innerText = new Intl.DateTimeFormat('en-US', {month:'long', year:'numeric'}).format(currentViewDate);
            const f = new Date(y, m, 1).getDay(), ds = new Date(y, m+1, 0).getDate();
            for(let i=0; i<f; i++) g.innerHTML += '<div class="day-cell bg-slate-900/5"></div>';
            for(let d=1; d<=ds; d++) {
                const dsK = \`\${y}-\${String(m+1).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`;
                const h = kvData['HOLIDAY:'+dsK], p = kvData['PLAN:'+dsK], l = kvData['LOG:'+dsK];
                const isT = new Date().toISOString().split('T')[0] === dsK;
                g.innerHTML += \`
                    <div onclick="toggleMode('\${dsK}')" class="day-cell border border-slate-700/10 p-2 cursor-pointer hover:bg-slate-800/40 \${isT?'bg-blue-500/10':''}">
                        <span class="text-xs \${isT?'text-blue-400 font-bold':'text-slate-500'}">\${d}</span>
                        <div class="flex flex-wrap mt-1">
                            \${h?'<span class="dot dot-holiday"></span>':''}
                            \${p==='LEAVE'?'<span class="dot dot-leave"></span>':''}
                            \${p==='WORK'?'<span class="dot dot-success"></span>':''}
                            \${l && (l.includes('SUCCESS') || l.includes('STARTED')) ? '<span class="dot dot-success shadow-lg shadow-green-500"></span>':''}
                        </div>
                        <div class="text-[7px] mt-1 truncate uppercase font-bold text-slate-400">\${h||''}</div>
                    </div>\`;
            }
        }
        function changeMonth(v) { currentViewDate.setMonth(currentViewDate.getMonth()+v); render(); }
        async function testPunch() { const r = await fetch('/api/punch?pwd='+PWD); alert(await r.text()); init(); }
        init();
    </script>
</body>
</html>
  `;
}
