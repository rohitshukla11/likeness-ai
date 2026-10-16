#!/bin/sh
# Build and deploy Likeness AI to Cloud Run (billed: Cloud Build minutes, Artifact Registry storage,
# Cloud Run requests). Run from web/:
#
#   sh scripts/deploy-gcp.sh PROJECT_ID
#
# Needs: gcloud signed in as a project owner; the setup in docs/deploy-gcp.md done (APIs, Firestore
# database "likeness", KMS keys, private bucket, service account likeness-run); web/.env.local with
# the public Firebase web config. Prints no secret: the C2PA test certificate goes to Secret Manager
# straight from ../.secrets/c2pa.
set -eu
PROJECT="${1:?usage: sh scripts/deploy-gcp.sh PROJECT_ID}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-likeness}"
SA="likeness-run@${PROJECT}.iam.gserviceaccount.com"
REPO="${REGION}-docker.pkg.dev/${PROJECT}/likeness"
GCLOUD="${GCLOUD:-gcloud}"
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
NUMBER="$($GCLOUD projects describe "$PROJECT" --format='value(projectNumber)')"
URL="${APP_URL:-https://${SERVICE}-${NUMBER}.${REGION}.run.app}"
val() { grep -E "^$1=" .env.local | tail -1 | cut -d= -f2-; }

echo "Project $PROJECT ($NUMBER), region $REGION, service $SERVICE → $URL"

# 1. Artifact Registry repository for the image (once).
$GCLOUD artifacts repositories describe likeness --location="$REGION" --project="$PROJECT" >/dev/null 2>&1 ||
  $GCLOUD artifacts repositories create likeness --repository-format=docker --location="$REGION" --project="$PROJECT" --quiet

# 2. C2PA test certificate in Secret Manager (once), readable only by the service account.
for pair in "c2pa-cert:../.secrets/c2pa/signer.pem" "c2pa-key:../.secrets/c2pa/signer.key"; do
  name="${pair%%:*}"; file="${pair#*:}"
  if ! $GCLOUD secrets describe "$name" --project="$PROJECT" >/dev/null 2>&1; then
    $GCLOUD secrets create "$name" --replication-policy=automatic --data-file="$file" --project="$PROJECT" --quiet >/dev/null
    echo "created secret $name"
  fi
  $GCLOUD secrets add-iam-policy-binding "$name" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --project="$PROJECT" --quiet >/dev/null
done

# 3. Build with Cloud Build (public Firebase config compiled in).
cat > /tmp/likeness-cloudbuild.yaml <<YAML
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, -t, "${REPO}/web:${TAG}",
      --build-arg, "NEXT_PUBLIC_FIREBASE_API_KEY=$(val NEXT_PUBLIC_FIREBASE_API_KEY)",
      --build-arg, "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=$(val NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN)",
      --build-arg, "NEXT_PUBLIC_FIREBASE_PROJECT_ID=$(val NEXT_PUBLIC_FIREBASE_PROJECT_ID)",
      --build-arg, "NEXT_PUBLIC_FIREBASE_APP_ID=$(val NEXT_PUBLIC_FIREBASE_APP_ID)",
      --build-arg, "NEXT_PUBLIC_APP_URL=${URL}",
      "."]
images: ["${REPO}/web:${TAG}"]
options:
  machineType: E2_HIGHCPU_8
timeout: 1800s
YAML
$GCLOUD builds submit . --config=/tmp/likeness-cloudbuild.yaml --project="$PROJECT" --quiet

# 4. Deploy to Cloud Run as the least-privilege service account.
$GCLOUD run deploy "$SERVICE" --image="${REPO}/web:${TAG}" --region="$REGION" --project="$PROJECT" \
  --service-account="$SA" --allow-unauthenticated \
  --cpu=2 --memory=2Gi --timeout=600 --concurrency=10 --min-instances=0 --max-instances=3 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT},GCP_REGION=${REGION},FIRESTORE_DATABASE=likeness,GCS_BUCKET=${PROJECT}-likeness-private,KMS_KEYRING=likeness,NEXT_PUBLIC_APP_URL=${URL},FACE_MATCH_THRESHOLD=${FACE_MATCH_THRESHOLD:-0.5},RENDERS_PER_DAY=${RENDERS_PER_DAY:-40},VIDEOS_PER_DAY=${VIDEOS_PER_DAY:-10}" \
  --set-secrets="C2PA_CERT_PEM=c2pa-cert:latest,C2PA_KEY_PEM=c2pa-key:latest" \
  --quiet

echo "Live: $URL   (status: $URL/status)"
echo "Add this domain to Firebase → Authentication → Settings → Authorized domains: ${URL#https://}"
