# ERP Attendance Automation Workflow

This document explains the technical flow of the automated attendance system, focusing on the transition from UI interaction to direct API calls.

## 1. Technical Architecture

### Authentication Mechanism
The system uses a hybrid approach:
1.  **UI Login:** Uses Puppeteer to interact with the login form. This handles standard web security features like redirects and session cookie initialization.
2.  **Credential Storage:** After login, the browser maintains a session cookie (`sid`).
3.  **CSRF Protection:** Frappe/ERPNext uses a CSRF token stored in `window.frappe.csrf_token`. This token must be present in the `X-Frappe-CSRF-Token` header for all state-changing API requests.

### API Endpoints Used
| Action | Method | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Login** | `POST` | `/api/method/login` | Validates `usr` and `pwd`. |
| **Check-in/Out** | `POST` | `/api/resource/Employee Checkin` | Standard REST API for creating records. |

---

## 2. The Execution Flow

### Step 1: Session Initialization
The script initializes a Puppeteer instance with specific geolocation permissions and overrides.

### Step 2: UI Authentication
- Navigates to the login page and submits credentials.
- **Verification:** Waits for `window.frappe.csrf_token` to load.

### Step 3: Direct REST API Call
The script uses `fetch()` inside the browser context to send a JSON payload:
```json
{
  "log_type": "IN",
  "time": "2026-04-29 13:38:46",
  "device_id": "AutomatedBot_JS",
  "latitude": 28.xxxx,
  "longitude": 77.xxxx
}
```
- **Security:** Authenticates via the `sid` cookie and `X-Frappe-CSRF-Token` header.

### Step 4: Verification
The server returns the generated Record ID (e.g., `EMP-CKIN-04-2026-002364`).

---

## 3. Results (Verified)
The flow was tested on 2026-04-29 and confirmed to work without manual UI interaction on the check-in page.
- **User:** 7842204844
- **Action:** OUT
- **Record Created:** EMP-CKIN-04-2026-002364
- **Status:** Success via REST API.

---

## 3. How Credentials are Used
- **Username/Password:** Only used once during the `Login` phase to establish the session.
- **sid (Session ID):** Managed by the browser's cookie jar.
- **CSRF Token:** Extracted dynamically for every session. It acts as a "second factor" for the API call to prevent cross-site forgery.

---

## 4. Manual Testing
To simulate or test the flow without the full script:
1. Log in to the ERP normally.
2. Open the Browser Console (F12).
3. Check `window.frappe.csrf_token` to see your current token.
4. The script essentially automates what you would do if you wrote a `fetch` command in the console.
