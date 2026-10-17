import "server-only";
/**
 * One image ad, end to end:
 *   checks (licence active and held by this brand, under its cap, brand has the credits, daily cap)
 *   → Gemini prompt safety filter → the creator's frames opened for this render (logged)
 *   → Gemini image generation → visible "AI-generated" label → C2PA manifest → sha256
 *   → KMS-signed receipt → one Firestore transaction: debit the brand, credit the creator (minus
 *   the 10% fee), count the render, store the render and its receipt → file to the private bucket.
 * Nothing is charged unless the whole render succeeds.
 */
import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { CATEGORIES } from "@/lib/categories";
import sharp from "sharp";
import { creatorFee, licenceStatus, videoRefusal, withVideoDefaults, type LicenceDoc, type ReceiptPayload, type VideoResolution } from "@/lib/model";
import { embedManifest } from "./c2pa";
import { getCreator } from "./creators";
import { checkPrompt, type FilterResult } from "./filter";
import { firestore } from "./firebase-admin";
import { demoLimits } from "./demo";
import { HttpError } from "./http";
import { labelRender } from "./label";
import { getLicence } from "./licences";
import { signPayload } from "./receipts";
import { geminiRender } from "./render/gemini";
import { putObject } from "./storage";
import { openFrames } from "./vault";
import type { GateRecord } from "./gate";

const db = () => firestore();
export const rendersPerDay = () => Number(process.env.RENDERS_PER_DAY ?? 40);
export const videosPerDay = () => Number(process.env.VIDEOS_PER_DAY ?? 10);
export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export type RenderDoc = {
  id: string;
  licenceId: string;
  brandId: string;
  creatorId: string;
  type: "image" | "video";
  renderIndex: number;
  sha256: string;
  mime: string;
  object: string;
  model: string;
  price: number;
  creatorShare: number;
  fee: number;
  brief: string;
  createdAt: number;
  /** Image only: the unlabelled still, kept private, which a video ad can start from. */
  rawObject?: string;
  /** A small labelled preview (images) or poster frame (videos) for the dashboards. */
  previewObject?: string;
  aspect?: "1:1" | "16:9" | "9:16";
  /** Video only: which pipeline made it, and the licensed still it started from. */
  pipeline?: "veo-3.1-lite" | "ffmpeg-fallback";
  fromRenderId?: string;
  pipelineNote?: string;
  /** Video only: the quality gate's result, the resolution, and how the still was framed for Veo. */
  gate?: GateRecord;
  resolution?: VideoResolution;
  framing?: string;
};

export class RenderRefused extends HttpError {
  constructor(
    status: number,
    message: string,
    readonly filter?: FilterResult,
  ) {
    super(status, message);
  }
}

/** A render as the browser sees it: the private storage paths stay on the server. */
export function publicRender(r: RenderDoc) {
  const { object: _o, rawObject: _r, previewObject: _p, ...pub } = r;
  void _o, void _r, void _p;
  return { ...pub, hasPreview: !!r.previewObject, hasRaw: !!r.rawObject };
}

/** Checks shared by image and video renders. Returns the licence and price. */
export async function preflight(brandUid: string, licenceId: string, type: "image" | "video", priceOf?: (l: LicenceDoc) => number): Promise<{ licence: LicenceDoc; price: number }> {
  const l = await getLicence(licenceId);
  if (!l) throw new RenderRefused(404, "no such licence");
  if (l.brandId !== brandUid) throw new RenderRefused(403, "this licence belongs to another brand");
  const status = licenceStatus(l);
  if (status !== "Active") throw new RenderRefused(409, `render refused: the licence is ${status.toLowerCase()}`);
  const price = priceOf ? priceOf(l) : type === "video" ? l.pricePerVideo : l.pricePerImage;
  const bal = Number((await db().collection("credits").doc(brandUid).get()).data()?.balance ?? 0);
  if (bal < price) throw new RenderRefused(402, `not enough demo credits: this ${type} costs ${price}, you have ${bal}`);
  const usage = (await db().collection("usage").doc(day()).get()).data() ?? {};
  if (Number(usage.renders ?? 0) >= rendersPerDay()) throw new RenderRefused(429, `the site's daily render limit (${rendersPerDay()}) is reached; try again after 00:00 UTC`);
  if (l.demoBrand) {
    const lim = demoLimits();
    if (Number(usage.demoRenders ?? 0) >= lim.rendersPerDay) throw new RenderRefused(429, `today's demo renders (${lim.rendersPerDay}) are used up; try again after 00:00 UTC, or sign in with Google`);
    if (type === "video" && Number(usage.demoVideos ?? 0) >= lim.videosPerDay) throw new RenderRefused(429, `today's demo videos (${lim.videosPerDay}) are used up; try again after 00:00 UTC, or sign in with Google`);
  }
  return { licence: l, price };
}

/** Charge and record a finished render atomically; refuses if the licence changed meanwhile. */
export async function settle(input: {
  brandUid: string;
  licence: LicenceDoc;
  type: "image" | "video";
  bytes: Uint8Array;
  mime: string;
  model: string;
  brief: string;
  renderId: string;
  pipeline?: RenderDoc["pipeline"];
  fromRenderId?: string;
  pipelineNote?: string;
  rawObject?: string;
  previewObject?: string;
  aspect?: RenderDoc["aspect"];
  /** Overrides the licence price (the free ffmpeg fallback is 0; 1080p video costs more). */
  price?: number;
  extra?: Pick<RenderDoc, "gate" | "resolution" | "framing">;
}): Promise<{ render: RenderDoc; receipt: Awaited<ReturnType<typeof signPayload>> }> {
  const { licence: l0 } = input;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const price = input.price ?? (input.type === "video" ? l0.pricePerVideo : l0.pricePerImage);
  const payload: ReceiptPayload = {
    v: 1,
    contentSha256: sha256,
    mime: input.mime,
    licenceId: l0.id,
    creatorId: l0.creatorId,
    brandId: l0.brandId,
    use: l0.use,
    renderType: input.type,
    renderIndex: l0.renderCount,
    model: input.model,
    price,
    createdAt: Date.now(),
    ...(input.pipeline ? { pipeline: input.pipeline } : {}),
    ...(input.fromRenderId ? { fromRenderId: input.fromRenderId } : {}),
  };
  const receipt = await signPayload(payload);
  const ext = input.mime === "video/mp4" ? "mp4" : input.mime === "image/png" ? "png" : "jpg";
  const object = `renders/${sha256}.${ext}`;
  await putObject(object, input.bytes, input.mime);
  const { creator: creatorShare, fee } = creatorFee(price);
  const render: RenderDoc = {
    id: input.renderId,
    licenceId: l0.id,
    brandId: l0.brandId,
    creatorId: l0.creatorId,
    type: input.type,
    renderIndex: l0.renderCount,
    sha256,
    mime: input.mime,
    object,
    model: input.model,
    price,
    creatorShare,
    fee,
    brief: input.brief,
    createdAt: payload.createdAt,
    ...(input.pipeline ? { pipeline: input.pipeline } : {}),
    ...(input.fromRenderId ? { fromRenderId: input.fromRenderId } : {}),
    ...(input.pipelineNote ? { pipelineNote: input.pipelineNote } : {}),
    ...(input.rawObject ? { rawObject: input.rawObject } : {}),
    ...(input.previewObject ? { previewObject: input.previewObject } : {}),
    ...(input.aspect ? { aspect: input.aspect } : {}),
    ...(input.extra ?? {}),
  };
  await db().runTransaction(async (tx) => {
    const lref = db().collection("licences").doc(l0.id);
    const bref = db().collection("credits").doc(l0.brandId);
    const cref = db().collection("credits").doc(l0.creatorId);
    const uref = db().collection("usage").doc(day());
    const [ls, bs, cs] = await Promise.all([tx.get(lref), tx.get(bref), tx.get(cref)]);
    const l = withVideoDefaults(ls.data() as LicenceDoc);
    const status = licenceStatus(l);
    if (status !== "Active") throw new RenderRefused(409, `render refused: the licence became ${status.toLowerCase()} during the render`);
    if (l.renderCount !== l0.renderCount) throw new RenderRefused(409, "another render on this licence finished first; try again");
    const bal = Number(bs.data()?.balance ?? 0);
    if (bal < price) throw new RenderRefused(402, "not enough demo credits");
    if (input.type === "video") {
      const today = Number((await tx.get(uref)).data()?.videos ?? 0);
      const why = videoRefusal(l, today, videosPerDay());
      if (why) throw new RenderRefused(409, `render refused: ${why}`);
    }
    tx.update(lref, { renderCount: l.renderCount + 1, ...(input.type === "video" ? { videoCount: (l.videoCount ?? 0) + 1 } : {}) });
    if (price > 0) {
      tx.set(bref, { uid: l0.brandId, balance: bal - price, updatedAt: Date.now() }, { merge: true });
      tx.set(cref, { uid: l0.creatorId, balance: Number(cs.data()?.balance ?? 0) + creatorShare, updatedAt: Date.now() }, { merge: true });
      tx.create(db().collection("ledger").doc(), { uid: l0.brandId, delta: -price, reason: `${input.type} render under licence ${l0.id}`, renderId: render.id, licenceId: l0.id, at: Date.now() });
      tx.create(db().collection("ledger").doc(), { uid: l0.creatorId, delta: creatorShare, reason: `${input.type} render by ${l0.brandName} (after ${fee} credit fee)`, renderId: render.id, licenceId: l0.id, at: Date.now() });
      tx.create(db().collection("ledger").doc(), { uid: "platform", delta: fee, reason: `10% fee on render ${render.id}`, renderId: render.id, at: Date.now() });
    }
    const demo = l0.demoBrand ? { demoRenders: FieldValue.increment(1), ...(input.type === "video" ? { demoVideos: FieldValue.increment(1) } : {}) } : {};
    tx.set(uref, { renders: FieldValue.increment(1), ...(input.type === "video" ? { videos: FieldValue.increment(1) } : {}), ...demo }, { merge: true });
    tx.create(db().collection("renders").doc(render.id), render);
    tx.create(db().collection("receipts").doc(sha256), { ...receipt, renderId: render.id });
  });
  return { render, receipt };
}

export async function renderImage(brandUid: string, licenceId: string, brief: string, aspectRatio: "1:1" | "16:9" | "9:16" = "1:1") {
  const { licence } = await preflight(brandUid, licenceId, "image");
  const categoryBit = CATEGORIES.find((c) => c.key === licence.use)?.bit ?? 0;
  const filter = await checkPrompt(brief, categoryBit);
  if (!filter.allowed) throw new RenderRefused(422, `render refused by the safety filter: ${filter.reasons.join("; ")}`, filter);
  const creator = await getCreator(licence.creatorId);
  if (!creator) throw new RenderRefused(404, "creator not found");
  const renderId = randomBytes(12).toString("base64url");
  const refs = await openFrames(creator, { licenceId, renderId, by: "render-service" });
  let out;
  try {
    out = await geminiRender({ prompt: brief, references: refs, licenceId, renderIndex: licence.renderCount, aspectRatio });
  } finally {
    refs.forEach((r) => r.fill(0));
  }
  // Keep the unlabelled still privately: a video ad under this licence can start from it.
  const rawObject = `renders/raw/${renderId}.jpg`;
  await putObject(rawObject, await sharp(out.bytes).jpeg({ quality: 94 }).toBuffer(), "image/jpeg");
  const labelled = await labelRender(out.bytes);
  const signed = embedManifest(new Uint8Array(labelled), "image/jpeg", {
    protocol: "likeness-ai/1",
    licenceId,
    renderIndex: licence.renderCount,
    renderType: "image",
    creator: { id: creator.uid, name: creator.displayName, youtubeChannelId: creator.channel?.channelId ?? null },
    licensee: { id: licence.brandId, name: licence.brandName },
    use: licence.use,
    receipt: { store: "Firestore receipts/{sha256}", key: "sha256 of this file, manifest included", signedBy: "Cloud KMS EC_SIGN_P256_SHA256", verify: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/verify` },
    renderer: { provider: "Vertex AI", model: out.model },
    promptSha256: createHash("sha256").update(brief).digest("hex"),
    createdAt: new Date().toISOString(),
  });
  const previewObject = `renders/preview/${renderId}.jpg`;
  await putObject(previewObject, await sharp(labelled).resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(), "image/jpeg");
  const { render, receipt } = await settle({ brandUid, licence, type: "image", bytes: signed, mime: "image/jpeg", model: out.model, brief, renderId, rawObject, previewObject, aspect: aspectRatio });
  return { render: publicRender(render), receipt: { keyVersion: receipt.keyVersion, alg: receipt.alg }, filter };
}
