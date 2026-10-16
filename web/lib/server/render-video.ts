import "server-only";
/**
 * One video ad from a still already licensed and paid for under the same licence:
 *   checks (licence active and held by this brand, video allowed, per-licence and per-day video caps,
 *   the brand has the credits for the chosen resolution) → the still must already be in the video's
 *   aspect → Gemini safety filter on the motion prompt → the still framed for Veo around the face
 *   (lib/server/framing.ts; never a centre crop) → Veo 3.1 Lite image-to-video with the motion prompt
 *   plus our motion and framing rules → quality gate (lib/server/gate.ts: the creator's face fully
 *   visible and matching in most sampled frames) → on failure one retry with stricter framing → visible
 *   label clear of the face → C2PA on the MP4 → KMS-signed receipt → atomic settlement.
 * If Veo refuses or fails, or the gate fails twice, a free ffmpeg motion ad is made from the same
 * framed still instead, the video price is not charged, and the render records why.
 */
import { createHash, randomBytes } from "node:crypto";
import { CATEGORIES } from "@/lib/categories";
import { veoPrompt } from "@/lib/creative";
import { videoPrice, videoRefusal, type VideoResolution } from "@/lib/model";
import { embedManifest } from "./c2pa";
import { getCreator } from "./creators";
import { referenceEmbeddings } from "./facematch";
import { checkPrompt } from "./filter";
import { firestore } from "./firebase-admin";
import { faceBoxes, fitStill } from "./framing";
import { runGate, type GateAttempt, type GateRecord } from "./gate";
import { labelVideo, motionAd, posterFrame } from "./motion";
import { day, preflight, publicRender, RenderRefused, settle, videosPerDay, type RenderDoc } from "./render-image";
import { getObject, putObject } from "./storage";
import { openFrames } from "./vault";
import { imageToVideo, veoEnabled, veoModel } from "./veo";

/** The request may run 10 minutes (route maxDuration, Cloud Run timeout); Veo gets what is left of 9. */
const BUDGET_MS = 540_000;

export const videoSize = (aspect: "16:9" | "9:16", resolution: VideoResolution): [number, number] => {
  const [long, short] = resolution === "1080p" ? [1920, 1080] : [1280, 720];
  return aspect === "16:9" ? [long, short] : [short, long];
};

const withoutFaces = ({ faces: _f, ...a }: GateAttempt) => (void _f, a);

export async function renderVideo(
  brandUid: string,
  input: { licenceId: string; fromRenderId: string; prompt: string; seconds: 6 | 8; aspectRatio: "16:9" | "9:16"; resolution?: VideoResolution },
) {
  const started = Date.now();
  const resolution = input.resolution ?? "720p";
  // Veo makes 1080p only as 8-second clips.
  const seconds = resolution === "1080p" ? 8 : input.seconds;
  const { licence, price } = await preflight(brandUid, input.licenceId, "video", (l) => videoPrice(l, resolution));
  const today = Number((await firestore().collection("usage").doc(day()).get()).data()?.videos ?? 0);
  const why = videoRefusal(licence, today, videosPerDay());
  if (why) throw new RenderRefused(409, `render refused: ${why}`);

  const from = (await firestore().collection("renders").doc(input.fromRenderId).get()).data() as RenderDoc | undefined;
  if (!from || from.licenceId !== licence.id || from.type !== "image" || !from.rawObject) throw new RenderRefused(400, "pick an image ad made under this licence to animate");
  const fromAspect = from.aspect ?? "1:1";
  if (fromAspect !== input.aspectRatio) throw new RenderRefused(409, `this image ad is ${fromAspect}: make a ${input.aspectRatio} still first, so the video doesn't have to crop it`);
  const categoryBit = CATEGORIES.find((c) => c.key === licence.use)?.bit ?? 0;
  const filter = await checkPrompt(input.prompt, categoryBit);
  if (!filter.allowed) throw new RenderRefused(422, `render refused by the safety filter: ${filter.reasons.join("; ")}`, filter);
  const raw = await getObject(from.rawObject);
  if (!raw) throw new RenderRefused(500, "the licensed still is missing");

  const [W, H] = videoSize(input.aspectRatio, resolution);
  const renderId = randomBytes(12).toString("base64url");
  const fitted = await fitStill(new Uint8Array(raw), W, H);

  // The creator's reference frames, opened for the gate (logged like every decryption), kept only as embeddings.
  const creator = await getCreator(licence.creatorId);
  if (!creator) throw new RenderRefused(404, "creator not found");
  const frames = await openFrames(creator, { licenceId: licence.id, renderId, by: "video quality gate" });
  let refs: Float32Array[];
  try {
    refs = await referenceEmbeddings(frames);
  } finally {
    frames.forEach((f) => f.fill(0));
  }
  if (!refs.length) throw new RenderRefused(500, "the quality gate found no usable reference face for this creator");

  const attempts: GateAttempt[] = [];
  let passed: { mp4: Uint8Array; gate: GateAttempt } | null = null;
  let veoError: string | null = veoEnabled() ? null : "Veo is turned off on this server";
  let model = "ffmpeg motion ad (fallback)";
  let veoMs = 0;
  for (const strict of [false, true]) {
    if (veoError) break;
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 90_000) {
      veoError = "not enough time left for the stricter retry";
      break;
    }
    try {
      const v = await imageToVideo({ image: fitted.bytes, mime: "image/jpeg", prompt: veoPrompt(input.prompt, input.aspectRatio, strict), seconds, aspectRatio: input.aspectRatio, resolution, timeoutMs: Math.min(240_000, left - 60_000) });
      veoMs += v.ms;
      model = v.model;
      const g = await runGate(v.bytes, refs, seconds);
      attempts.push(g);
      if (g.passed) {
        passed = { mp4: v.bytes, gate: g };
        break;
      }
    } catch (e) {
      veoError = (e as Error).message.slice(0, 200);
    }
  }

  let video: Uint8Array;
  let pipeline: RenderDoc["pipeline"];
  let note: string;
  let gate: GateRecord;
  let charged: number;
  let faces: GateAttempt["faces"];
  if (passed) {
    video = passed.mp4;
    pipeline = "veo-3.1-lite";
    charged = price;
    faces = passed.gate.faces;
    const retried = attempts.length > 1;
    gate = { ...withoutFaces(passed.gate), attempts: attempts.map(withoutFaces), outcome: retried ? "passed on retry" : "passed" };
    note = `Veo 3.1 Lite image-to-video, ${seconds} s, ${resolution}; passed the quality gate${retried ? " on the stricter retry" : ""}; Veo took ${Math.round(veoMs / 1000)} s`;
  } else {
    // The free fallback, from the same framed still, zooming toward the face.
    const f = (await faceBoxes(fitted.bytes)).faces[0];
    const focus = f ? { x: (f.x + f.w / 2) / W, y: (f.y + f.h / 2) / H } : undefined;
    video = await motionAd({ still: fitted.bytes, brand: licence.brandName, aspectRatio: input.aspectRatio, seconds, size: [W, H], focus });
    pipeline = "ffmpeg-fallback";
    model = "ffmpeg motion ad (fallback)";
    charged = 0;
    const check = await runGate(video, refs, Math.max(3, seconds - 2));
    faces = check.faces;
    const failed = attempts.length ? `the quality gate failed ${attempts.length === 2 ? "twice" : "once"} (${attempts[attempts.length - 1].reason})` : "";
    const cause = [failed, veoError ? `Veo: ${veoError}` : ""].filter(Boolean).join("; then ");
    gate = { ...withoutFaces(check), attempts: attempts.map(withoutFaces), outcome: attempts.length ? "failed, fallback used" : "Veo unavailable, fallback used" };
    note = `Free fallback motion ad: ${cause}. The video price (${price} credits) was not charged.`;
  }

  const labelled = await labelVideo(video, W, H, faces.map((b) => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H })));
  const previewObject = `renders/preview/${renderId}.jpg`;
  await putObject(previewObject, await posterFrame(labelled.bytes), "image/jpeg");
  const signed = embedManifest(labelled.bytes, "video/mp4", {
    protocol: "likeness-ai/1",
    licenceId: licence.id,
    renderIndex: licence.renderCount,
    renderType: "video",
    creator: { id: licence.creatorId, name: creator.displayName ?? licence.creatorName, youtubeChannelId: creator.channel?.channelId ?? null },
    licensee: { id: licence.brandId, name: licence.brandName },
    use: licence.use,
    receipt: { store: "Firestore receipts/{sha256}", key: "sha256 of this file, manifest included", signedBy: "Cloud KMS EC_SIGN_P256_SHA256", verify: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/verify` },
    renderer: { provider: pipeline === "veo-3.1-lite" ? "Vertex AI" : "ffmpeg", model: pipeline === "veo-3.1-lite" ? veoModel() : model },
    promptSha256: createHash("sha256").update(input.prompt).digest("hex"),
    createdAt: new Date().toISOString(),
  });
  const { render, receipt } = await settle({
    brandUid,
    licence,
    type: "video",
    bytes: signed,
    mime: "video/mp4",
    model,
    brief: input.prompt,
    renderId,
    pipeline,
    pipelineNote: note,
    fromRenderId: from.id,
    previewObject,
    aspect: input.aspectRatio,
    price: charged,
    extra: { gate, resolution, framing: `${fitted.method}; label ${labelled.corner}` },
  });
  return { render: publicRender(render), receipt: { keyVersion: receipt.keyVersion, alg: receipt.alg }, pipeline, note, veoMs, gate };
}
