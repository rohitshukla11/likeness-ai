# Deploying Likeness AI on Google Cloud

Everything runs in one project, region **us-central1** (the only region with Veo 3.1 Lite). Gemini uses
Vertex AI's global endpoint. No API keys: the Cloud Run service account calls Google APIs.

## One-time setup

1. Project with billing and a budget alert; enable the APIs:
   `run cloudbuild artifactregistry aiplatform firestore cloudkms storage secretmanager iamcredentials
   logging youtube identitytoolkit firebase` (all `.googleapis.com`).
2. Firestore (Native mode) **named database `likeness`** in us-central1.
3. Private bucket `gs://PROJECT-likeness-private` (uniform access, public access prevention).
4. Cloud KMS key ring `likeness` (us-central1): key `photos` (symmetric, envelope encryption) and key
   `receipts` (asymmetric signing, `EC_SIGN_P256_SHA256`). Turn on **Data Access audit logs** for Cloud
   KMS so every decryption is logged by Google as well as in Firestore.
5. Service account `likeness-run` with: `roles/datastore.user`, `roles/aiplatform.user`,
   `roles/logging.logWriter`; `roles/storage.objectAdmin` on the bucket only;
   `roles/cloudkms.cryptoKeyEncrypterDecrypter` on `photos` only; `roles/cloudkms.signerVerifier` on
   `receipts` only; `roles/iam.serviceAccountTokenCreator` on itself (V4 signed URLs). It is the only
   identity that can open a creator's photos.
6. Firebase: add Firebase to the project, enable Google sign-in, register a web app and copy its config.
7. OAuth consent screen: External, **Testing**, test users added, scopes `openid email profile
   youtube.readonly`. In Testing, up to 100 test users; their authorizations expire after 7 days.

## Configuration

`web/.env.local` (see `web/.env.example`): the public Firebase web config and the project settings. The
C2PA test certificate (`sh scripts/c2pa-testcert.sh`) goes to Secret Manager (`c2pa-cert`, `c2pa-key`).

## Deploy

```sh
cd web
sh scripts/deploy-gcp.sh PROJECT_ID
```

It creates the Artifact Registry repository and the two secrets once, builds the image with Cloud Build
(Next.js standalone, face-matcher models baked in, ffmpeg for the video fallback), and deploys Cloud Run
service `likeness` as `likeness-run` with `--allow-unauthenticated`, 2 vCPU / 2 GiB, 0–3 instances, a 600 s
request timeout (a video ad can take two Veo calls when the quality gate retries).
Then add the printed `*.run.app` domain to **Firebase → Authentication → Settings → Authorized domains**,
and check `/api/status` (JSON): every Google service should report `ok: true`.

## Local development

```sh
gcloud auth application-default login
cd web && cp .env.example .env.local   # fill in
pnpm install && pnpm face:models && pnpm c2pa:testcert
pnpm dev
pnpm seed:demo "Name" "appearance"     # a synthetic demo creator (generated face, labelled)
pnpm e2e:smoke demo-<name>             # one paid image render end to end (about $0.03 of Gemini)
```
