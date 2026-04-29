const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Helper for logging
function log(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    console.log(`[${timestamp}] ${message}`);
}

async function run() {
    // 1. Load Configuration
    const configPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(configPath)) {
        console.error("Error: config.json not found. Please create it based on your Python setup.");
        process.exit(1);
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const browser = await puppeteer.launch({
        headless: config.headless !== false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        for (const user of config.users) {
            log(`--- Processing User: ${user.username} ---`);
            const context = await browser.createBrowserContext();
            
            // Set Geolocation permissions
            await context.overridePermissions(config.login_url, ['geolocation']);
            
            const page = await context.newPage();
            await page.setGeolocation({
                latitude: parseFloat(config.latitude),
                longitude: parseFloat(config.longitude)
            });

            // 2. Login
            log(`(${user.username}) Navigating to Login...`);
            await page.goto(config.login_url, { waitUntil: 'networkidle2' });
            
            await page.type('input[type="text"], input[name="usr"]', user.username);
            await page.type('input[type="password"]', user.password);
            
            // Click Login Button
            log(`(${user.username}) Attempting Login...`);
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const loginBtn = buttons.find(btn => 
                    btn.innerText.includes('Login') || 
                    btn.classList.contains('btn-login') ||
                    btn.getAttribute('type') === 'submit'
                );
                if (loginBtn) loginBtn.click();
                else throw new Error("Login button not found");
            });
            
            // Wait for navigation and Frappe to initialize
            await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
            await page.waitForFunction(() => window.frappe && window.frappe.csrf_token, { timeout: 15000 }).catch(e => {
                log(`WARNING: Frappe boot timeout for ${user.username}. Checking if session exists...`);
            });

            // 3. Extract CSRF Token and verify login
            const authData = await page.evaluate(() => {
                return {
                    csrf_token: window.frappe ? window.frappe.csrf_token : null,
                    full_name: window.frappe && window.frappe.boot ? window.frappe.boot.user.full_name : "User"
                };
            });

            if (!authData.csrf_token) {
                log(`ERROR: Could not extract CSRF token for ${user.username}. Check credentials.`);
                await context.close();
                continue;
            }

            log(`(${user.username}) Logged in as: ${authData.full_name}. CSRF Token obtained.`);

            // 4. API Flow - Direct Call (REST API)
            const currentHour = new Date().getHours();
            const logType = currentHour < 14 ? 'IN' : 'OUT'; // Before 2 PM is IN, After is OUT
            
            log(`(${user.username}) Sending ${logType} API request (REST)...`);
            
            const apiResult = await page.evaluate(async (lat, lon, type) => {
                const now = new Date();
                // Format: YYYY-MM-DD HH:mm:ss
                const timestamp = now.getFullYear() + '-' + 
                    String(now.getMonth() + 1).padStart(2, '0') + '-' + 
                    String(now.getDate()).padStart(2, '0') + ' ' + 
                    String(now.getHours()).padStart(2, '0') + ':' + 
                    String(now.getMinutes()).padStart(2, '0') + ':' + 
                    String(now.getSeconds()).padStart(2, '0');

                const payload = {
                    log_type: type,
                    time: timestamp,
                    device_id: "AutomatedBot_JS",
                    latitude: lat,
                    longitude: lon
                };

                try {
                    const response = await fetch('/api/resource/Employee Checkin', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Frappe-CSRF-Token': window.frappe.csrf_token
                        },
                        body: JSON.stringify(payload)
                    });
                    const data = await response.json();
                    return { ok: response.ok, data: data, status: response.status };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            }, config.latitude, config.longitude, logType);

            if (apiResult.ok) {
                const docName = apiResult.data.data ? apiResult.data.data.name : 'Success';
                log(`SUCCESS: User ${user.username} logged ${logType}. Record: ${docName}`);
            } else {
                log(`FAILED: API error (${apiResult.status}) for ${user.username}: ${JSON.stringify(apiResult.data || apiResult.error)}`);
            }

            await context.close();
            // Wait a bit between users
            await new Promise(r => setTimeout(r, 2000));
        }
    } catch (err) {
        log(`CRITICAL ERROR: ${err.message}`);
    } finally {
        await browser.close();
        log("=== Batch Automation Finished ===");
    }
}

run();
