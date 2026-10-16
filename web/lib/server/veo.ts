import "server-only";
/**
 * Veo 3.1 Lite image-to-video on Vertex AI (us-central1, the model's only region):
 *   POST …/models/veo-3.1-lite-generate-001:predictLongRunning, then poll :fetchPredictOperation.
 * personGeneration "allow_adult" (Google's default: adults only). Durations 4, 6 or 8 s; 720p; 16:9 or
 * 9:16; silent unless asked. Price (Vertex pricing page): $0.03 per second of 720p video without audio.
 * A refusal comes back as an error or as zero videos with raiMediaFilteredReasons; both are VeoRefused,
 * so the caller can fall back and say why.
 */
import { accessToken, gcp, requireProject } from "./gcp";

export const veoModel = () => process.env.VEO_MODEL || "veo-3.1-lite-generate-001";
export const veoEnabled = () => process.env.VEO_DISABLED !== "1" && !!gcp.project();

export class VeoRefused extends Error {
  constructor(message: string) {
    super(message);
  }
}

type Op = { name: string; done?: boolean; error?: { code?: number; message?: string }; response?: { videos?: { bytesBase64Encoded?: string; mimeType?: string }[]; raiMediaFilteredCount?: number; raiMediaFilteredReasons?: string[] } };

async function call(url: string, body: unknown): Promise<Op> {
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const j = (await r.json().catch(() => ({}))) as Op & { error?: { message?: string; status?: string } };
  if (!r.ok) throw new VeoRefused(`Veo HTTP ${r.status} ${j.error?.status ?? ""}: ${j.error?.message ?? "no message"}`.trim());
  return j;
}

export async function imageToVideo(input: {
  image: Uint8Array;
  mime: "image/jpeg" | "image/png";
  prompt: string;
  seconds: 4 | 6 | 8;
  aspectRatio: "16:9" | "9:16";
  audio?: boolean;
}): Promise<{ bytes: Uint8Array; model: string; ms: number }> {
  const project = requireProject();
  const model = veoModel();
  const base = `https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/${model}`;
  const t = Date.now();
  const op = await call(`${base}:predictLongRunning`, {
    instances: [{ prompt: input.prompt, image: { bytesBase64Encoded: Buffer.from(input.image).toString("base64"), mimeType: input.mime } }],
    parameters: { durationSeconds: input.seconds, resolution: "720p", aspectRatio: input.aspectRatio, generateAudio: !!input.audio, personGeneration: "allow_adult", sampleCount: 1 },
  });
  for (;;) {
    if (Date.now() - t > 240_000) throw new VeoRefused("Veo took longer than 4 minutes");
    await new Promise((r) => setTimeout(r, 5_000));
    const r = await call(`${base}:fetchPredictOperation`, { operationName: op.name });
    if (!r.done) continue;
    if (r.error) throw new VeoRefused(`Veo error: ${r.error.message ?? r.error.code}`);
    const v = r.response?.videos?.[0];
    if (!v?.bytesBase64Encoded) {
      const why = r.response?.raiMediaFilteredReasons?.join("; ") || "no video returned";
      throw new VeoRefused(`Veo declined to generate this video: ${why}`);
    }
    return { bytes: new Uint8Array(Buffer.from(v.bytesBase64Encoded, "base64")), model, ms: Date.now() - t };
  }
}
