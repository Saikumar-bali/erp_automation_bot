export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAttendance(env));
  },
  async fetch(request, env) {
    // Allows manual testing via the Worker URL
    return new Response(await runAttendance(env));
  }
};

async function runAttendance(env) {
  const config = JSON.parse(env.CONFIG);
  const now = new Date();
  
  // Convert UTC to IST (UTC + 5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);
  const hour = istDate.getHours();
  
  // Logic: 10:00 AM IST (Hour 10) is IN, 7:00 PM IST (Hour 19) is OUT
  // We use 14:00 (2 PM) as the split point
  const logType = hour < 14 ? 'IN' : 'OUT'; 
  
  let report = `--- Attendance Report (${istDate.toISOString()}) ---\n`;
  report += `Log Type: ${logType}\n`;

  for (const user of config.users) {
    try {
      // 1. LOGIN
      // Frappe login endpoint usually expects usr and pwd
      const loginUrl = `${config.login_url.split('/login')[0]}/api/method/login`;
      const loginRes = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usr: user.username, pwd: user.password })
      });

      if (!loginRes.ok) {
        report += `FAILED: Login failed for ${user.username} (Status: ${loginRes.status})\n`;
        continue;
      }

      const cookies = loginRes.headers.get('set-cookie') || '';
      const sid = cookies.match(/sid=([^;]+)/)?.[1];
      const csrfToken = cookies.match(/frappe_csrf_token=([^;]+)/)?.[1];

      if (!sid) {
        report += `FAILED: No SID cookie returned for ${user.username}\n`;
        continue;
      }

      // 2. POST ATTENDANCE (REST API)
      const attendanceUrl = `${config.login_url.split('/login')[0]}/api/resource/Employee Checkin`;
      
      const timestamp = istDate.getFullYear() + '-' + 
          String(istDate.getMonth() + 1).padStart(2, '0') + '-' + 
          String(istDate.getDate()).padStart(2, '0') + ' ' + 
          String(istDate.getHours()).padStart(2, '0') + ':' + 
          String(istDate.getMinutes()).padStart(2, '0') + ':' + 
          String(istDate.getSeconds()).padStart(2, '0');

      const payload = {
        log_type: logType,
        time: timestamp,
        device_id: "Cloudflare_Worker_Bot",
        latitude: config.latitude,
        longitude: config.longitude
      };

      const response = await fetch(attendanceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `sid=${sid}`,
          'X-Frappe-CSRF-Token': csrfToken || ''
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      
      if (response.ok) {
        report += `SUCCESS: ${user.username} logged ${logType}. Record: ${result.data?.name || 'Success'}\n`;
      } else {
        report += `FAILED: ${user.username} API Error: ${JSON.stringify(result)}\n`;
      }
    } catch (e) {
      report += `ERROR: ${user.username} Exception: ${e.message}\n`;
    }
  }

  console.log(report);
  return report;
}
