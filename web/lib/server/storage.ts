import "server-only";
/**
 * The private Cloud Storage bucket (uniform access, public access prevention). Objects:
 *   vault/<creator>/<n>.bin      encrypted reference frames (ciphertext only)
 *   public/<creator>.jpg         the creator's public photo (512 px, labelled)
 *   renders/<sha256>.<ext>       paid renders, delivered by short-lived V4 signed URLs
 */
import { Storage } from "@google-cloud/storage";
import { gcp } from "./gcp";

let client: Storage | null = null;
const bucket = () => (client ??= new Storage()).bucket(gcp.bucket());

export async function putObject(path: string, bytes: Uint8Array | Buffer, contentType: string): Promise<void> {
  await bucket().file(path).save(Buffer.from(bytes), { contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } });
}

export async function getObject(path: string): Promise<Buffer | null> {
  const f = bucket().file(path);
  const [exists] = await f.exists();
  if (!exists) return null;
  const [b] = await f.download();
  return b;
}

/** A V4 signed URL for reading one object (the service account signs through IAM signBlob). */
export async function signedUrl(path: string, minutes = 15): Promise<string> {
  const [url] = await bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + minutes * 60_000 });
  return url;
}
