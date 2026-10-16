"""Smoke test: a synthetic face from Gemini on Vertex, then Veo 3.1 Lite image-to-video (4 s, 720p, silent).

    python3 scripts/veo-smoke.py PROJECT_ID

Uses `gcloud auth print-access-token`. Output goes to .secrets/ai/veo-test/ (git-ignored). About $0.12 of Veo.
"""
import base64, json, os, subprocess, sys, time, urllib.request

PROJECT = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "..", ".secrets", "ai", "veo-test")
os.makedirs(OUT, exist_ok=True)
GCLOUD = os.path.expanduser("~/.local/bin/gcloud")
token = subprocess.check_output([GCLOUD, "auth", "print-access-token"], text=True).strip()

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=300))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} from {url.split('/models/')[-1]}: {e.read().decode()[:600]}")

# 1. Synthetic face (Gemini Nano Banana 2.1, global endpoint)
t = time.time()
img = post(f"https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/global/publishers/google/models/gemini-nano-banana-2.1:generateContent", {
    "contents": [{"role": "user", "parts": [{"text": "Photorealistic portrait of a fictional adult, not resembling any real person. Head and shoulders, friendly expression, soft window light, plain warm background, 16:9 framing."}]}],
    "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": "16:9"}},
})
part = next(p for p in img["candidates"][0]["content"]["parts"] if "inlineData" in p)
face = base64.b64decode(part["inlineData"]["data"])
mime = part["inlineData"]["mimeType"]
open(os.path.join(OUT, "face." + ("png" if "png" in mime else "jpg")), "wb").write(face)
print(f"face: {mime}, {len(face)} bytes, {time.time()-t:.1f}s")

# 2. Veo 3.1 Lite image-to-video (us-central1)
model = "veo-3.1-lite-generate-001"
base = f"https://us-central1-aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/us-central1/publishers/google/models/{model}"
t = time.time()
op = post(f"{base}:predictLongRunning", {
    "instances": [{"prompt": "The person smiles warmly and lifts a ceramic coffee cup toward the camera, gentle push-in, cosy cafe light.",
                   "image": {"bytesBase64Encoded": base64.b64encode(face).decode(), "mimeType": mime}}],
    "parameters": {"durationSeconds": 4, "resolution": "720p", "aspectRatio": "16:9", "generateAudio": False, "personGeneration": "allow_adult", "sampleCount": 1},
})
name = op["name"]
print("operation started:", name.split("/operations/")[-1])
while True:
    time.sleep(10)
    r = post(f"{base}:fetchPredictOperation", {"operationName": name})
    if r.get("done"):
        break
    print(f"  waiting… {time.time()-t:.0f}s")
if "error" in r:
    raise SystemExit(f"Veo error: {json.dumps(r['error'])[:600]}")
resp = r.get("response", {})
vids = resp.get("videos", [])
if not vids:
    raise SystemExit(f"no video returned (filtered?): {json.dumps(resp)[:600]}")
v = vids[0]
data = base64.b64decode(v["bytesBase64Encoded"]) if "bytesBase64Encoded" in v else None
path = os.path.join(OUT, "veo-lite-4s.mp4")
if data:
    open(path, "wb").write(data)
print(f"video: {len(data) if data else 0} bytes in {time.time()-t:.0f}s → {path if data else v.get('gcsUri')}; filtered count: {resp.get('raiMediaFilteredCount', 0)}")
