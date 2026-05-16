import requests
import json

url = "https://hippo-attendance-worker.saikumarbali555.workers.dev/api/logs?pwd=YourSecretPassword123"
r = requests.get(url)
data = r.json()
print("Keys found in /api/logs:")
for k in sorted(data.keys()):
    print(f"- {k}: {data[k][:50]}...")
