import json
import time
import sys
import os
from datetime import datetime
from playwright.sync_api import sync_playwright

# --- CONFIGURATION LOADER ---
def load_config():
    try:
        if os.path.exists('config.json'):
            with open('config.json', 'r') as f: return json.load(f)
        elif os.path.exists('../config.json'):
            with open('../config.json', 'r') as f: return json.load(f)
        else:
            print("Error: config.json not found.")
            sys.exit(1)
    except Exception as e:
        print(f"Config Error: {e}")
        sys.exit(1)

config = load_config()

# --- LOGGING HELPER ---
def log(message):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    entry = f"[{timestamp}] {message}"
    print(entry)
    if not os.path.exists("logs"):
        os.makedirs("logs")
    with open("logs/attendance_log.txt", "a") as f:
        f.write(entry + "\n")

def close_blocking_modals(page):
    """Checks for blocking error modals and closes them."""
    try:
        modal = page.locator(".modal.show, .modal.fade.show")
        if modal.count() > 0 and modal.is_visible():
            log("WARNING: Blocking modal detected. Attempting to close...")
            try:
                page.click(".modal.show button.close", timeout=1000)
            except:
                try:
                    page.click(".modal.show button[aria-label='Close']", timeout=1000)
                except:
                    page.keyboard.press("Escape")
            time.sleep(1)
            return True
    except:
        pass
    return False

def process_single_user(context, user_config):
    """Handles the login and punch logic for a single user."""
    username = user_config['username']
    password = user_config['password']
    
    page = context.new_page()
    
    try:
        log(f"--- Processing User: {username} ---")
        
        # 1. LOGIN
        log(f"({username}) Navigating to Login...")
        page.goto(config['login_url'])
        
        # Wait for input and fill
        page.wait_for_selector("input[type='password']", timeout=10000)
        page.fill("input[type='text'], input[name='usr']", username)
        page.fill("input[type='password']", password)
        page.click("button:has-text('Login')")
        
        # Wait for login to complete
        page.wait_for_load_state('networkidle')
        
        # 2. NAVIGATE TO CHECK-IN
        time.sleep(2)
        target_url = "https://erp.hippoclouds.com/app/employee-checkin/new-employee-checkin"
        page.goto(target_url)
        page.wait_for_load_state('networkidle')
        
        # Check for errors immediately
        close_blocking_modals(page)

        # 3. FETCH LOCATION
        log(f"({username}) Fetching geolocation...")
        fetch_btn = page.locator("button:has-text('Fetch Geolocation'), button:has-text('Fetch Location')")
        
        if fetch_btn.is_visible():
            fetch_btn.click()
            time.sleep(5) # Wait for map
            close_blocking_modals(page)
        
        # 4. SAVE (Retry Logic)
        log(f"({username}) Clicking Save...")
        save_btn = page.locator("button.btn-primary:has-text('Save')")
        
        saved = False
        for attempt in range(3):
            try:
                close_blocking_modals(page)
                if save_btn.is_enabled():
                    save_btn.click(timeout=5000)
                    saved = True
                    break
            except:
                time.sleep(2)
        
        if not saved:
            raise Exception("Could not click Save button.")

        # 5. VERIFY & CAPTURE POPUP
        # We now wait specifically for the success modal to appear before screenshotting.
        try:
            # Selector for the text found in the 'Welcome' popup
            success_selector = "text=Successfully punched IN, text=Welcome"
            page.wait_for_selector(success_selector, timeout=10000)
            
            # Small buffer to let the modal animation finish so the proof is clear
            time.sleep(1) 
            
            log(f"SUCCESS: User {username} punched. Capturing Welcome popup.")
            
            # Take screenshot while the modal is visible
            page.screenshot(path=f"logs/proof_{username}_{int(time.time())}.png")
            
            # Close the modal so the context is clean
            page.keyboard.press("Escape") 
            
        except Exception as e:
            log(f"WARNING: User {username} verification/screenshot timed out: {e}")
            page.screenshot(path=f"logs/fail_{username}_{int(time.time())}.png")

    except Exception as e:
        log(f"ERROR for user {username}: {str(e)}")
        page.screenshot(path=f"logs/error_{username}_{int(time.time())}.png")
    finally:
        page.close()

def run_attendance():
    log("=== Starting Batch Attendance Automation ===")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=config['headless'])
        
        # Loop through each user in the config
        users = config.get('users', [])
        
        if not users:
            log("No users found in config.json!")
            return

        for user in users:
            # Create a FRESH context for each user (clears cookies/session)
            context = browser.new_context(
                permissions=["geolocation"],
                geolocation={"latitude": config['latitude'], "longitude": config['longitude']},
                viewport={"width": 1280, "height": 720},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
            
            # Run logic for this specific user
            process_single_user(context, user)
            
            # Close context to clean up session
            context.close()
            
            # Small pause between users
            time.sleep(2)

        browser.close()
        log("=== Batch Automation Finished ===")

if __name__ == "__main__":
    run_attendance()