import "server-only";
/**
 * Google Cloud configuration for the whole server. One project; Vertex AI Gemini on the global
 * endpoint; Veo, Firestore, KMS and the private bucket in REGION (us-central1: the only region
 * with Veo 3.1 Lite). Credentials are Application Default Credentials: the Cloud Run service account
 * in production, `gcloud auth application-default login` locally. No API keys.
 */
import { GoogleAuth } from "google-auth-library";

export const gcp = {
  project: () => process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || "",
  region: () => process.env.GCP_REGION || "us-central1",
  firestoreDb: () => process.env.FIRESTORE_DATABASE || "likeness",
  bucket: () => process.env.GCS_BUCKET || (gcp.project() ? `${gcp.project()}-likeness-private` : ""),
  kmsKeyRing: () => process.env.KMS_KEYRING || "likeness",
  photoKey: () => `projects/${gcp.project()}/locations/${gcp.region()}/keyRings/${gcp.kmsKeyRing()}/cryptoKeys/${process.env.KMS_PHOTO_KEY || "photos"}`,
  receiptKey: () => `projects/${gcp.project()}/locations/${gcp.region()}/keyRings/${gcp.kmsKeyRing()}/cryptoKeys/${process.env.KMS_RECEIPT_KEY || "receipts"}`,
  receiptKeyVersion: () => `${gcp.receiptKey()}/cryptoKeyVersions/${process.env.KMS_RECEIPT_KEY_VERSION || "1"}`,
};

let auth: GoogleAuth | null = null;
/** An OAuth access token for Google APIs called over REST (Vertex AI). */
export async function accessToken(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const t = await auth.getAccessToken();
  if (!t) throw Object.assign(new Error("no Google credentials (ADC) on this server"), { status: 503 });
  return t;
}

export function requireProject(): string {
  const p = gcp.project();
  if (!p) throw Object.assign(new Error("GOOGLE_CLOUD_PROJECT is not set"), { status: 503 });
  return p;
}
