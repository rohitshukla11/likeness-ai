import "server-only";
/**
 * One video ad, in two steps, from a still already licensed and paid for under the same licence:
 *   checks (licence active and held by this brand, video allowed, per-licence and per-day video caps,
 *   the brand has the credits) → Gemini safety filter on the motion prompt → the unlabelled licensed
 *   still → Veo 3.1 Lite image-to-video (720p, 6 or 8 s, silent) → visible label → C2PA on the MP4 →
 *   KMS-signed receipt → atomic settlement at the creator's video price.
 * If Veo refuses or fails, a free ffmpeg motion ad (zoom and pan, caption, brand end-card) is made
 * from the same still instead, charged nothing, and the render says which pipeline made it.
 */
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { CATEGORIES } from "@/lib/categories";
import { videoRefusal } from "@/lib/model";
import { embedManifest } from "./c2pa";
import { getCreator } from "./creators";
import { checkPrompt } from "./filter";
import { firestore } from "./firebase-admin";
import { labelVideo, motionAd, posterFrame } from "./motion";
import { day, preflight, publicRender, RenderRefused, settle, videosPerDay, type RenderDoc } from "./render-image";
import { getObject, putObject } from "./storage";
import { imageToVideo, veoEnabled, veoModel } from "./veo";

export async function renderVideo(brandUid: string, input: { licenceId: string; fromRenderId: string; prompt: string; seconds: 6 | 8; aspectRatio: "16:9" | "9:16" }) {
  const { licence, price } = await preflight(brandUid, input.licenceId, "video");
  const today = Number((await firestore().collection("usage").doc(day()).get()).data()?.videos ?? 0);
  const why = videoRefusal(licence, today, videosPerDay());
  if (why) throw new RenderRefused(409, `render refused: ${why}`);

  const from = (await firestore().collection("renders").doc(input.fromRenderId).get()).data() as RenderDoc | undefined;
  if (!from || from.licenceId !== licence.id || from.type !== "image" || !from.rawObject) throw new RenderRefused(400, "pick an image ad made under this licence to animate");
  const categoryBit = CATEGORIES.find((c) => c.key === licence.use)?.bit ?? 0;
  const filter = await checkPrompt(input.prompt, categoryBit);
  if (!filter.allowed) throw new RenderRefused(422, `render refused by the safety filter: ${filter.reasons.join("; ")}`, filter);
  const raw = await getObject(from.rawObject);
  if (!raw) throw new RenderRefused(500, "the licensed still is missing");

  const [W, H] = input.aspectRatio === "16:9" ? [1280, 720] : [720, 1280];
  const renderId = randomBytes(12).toString("base64url");
  const still = new Uint8Array(await sharp(raw).resize(W, H, { fit: "cover", position: "attention" }).jpeg({ quality: 94 }).toBuffer());
  let mp4: Uint8Array;
  let pipeline: RenderDoc["pipeline"];
  let model: string;
  let note: string;
  let veoMs: number | undefined;
  try {
    if (!veoEnabled()) throw new Error("Veo is turned off on this server");
    const v = await imageToVideo({ image: still, mime: "image/jpeg", prompt: input.prompt, seconds: input.seconds, aspectRatio: input.aspectRatio });
    mp4 = v.bytes;
    pipeline = "veo-3.1-lite";
    model = v.model;
    veoMs = v.ms;
    note = `Veo 3.1 Lite image-to-video, ${input.seconds} s, 720p, made in ${Math.round(v.ms / 1000)} s`;
  } catch (e) {
    const brand = licence.brandName;
    mp4 = await motionAd({ still, caption: input.prompt, brand, aspectRatio: input.aspectRatio, seconds: input.seconds });
    pipeline = "ffmpeg-fallback";
    model = "ffmpeg motion ad (fallback)";
    note = `Fallback motion ad (free): ${(e as Error).message.slice(0, 200)}`;
  }

  const labelled = await labelVideo(mp4, W);
  const previewObject = `renders/preview/${renderId}.jpg`;
  await putObject(previewObject, await posterFrame(labelled), "image/jpeg");
  const creator = await getCreator(licence.creatorId);
  const signed = embedManifest(labelled, "video/mp4", {
    protocol: "likeness-ai/1",
    licenceId: licence.id,
    renderIndex: licence.renderCount,
    renderType: "video",
    creator: { id: licence.creatorId, name: creator?.displayName ?? licence.creatorName, youtubeChannelId: creator?.channel?.channelId ?? null },
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
    price: pipeline === "veo-3.1-lite" ? price : 0,
  });
  return { render: publicRender(render), receipt: { keyVersion: receipt.keyVersion, alg: receipt.alg }, pipeline, note, veoMs };
}
