/**
 * End-to-end check of the licensing pipeline against the real project (one Gemini image, about $0.03):
 * brand profile → demo top-up → request → creator approves → image ad (filter, KMS decrypt logged,
 * Gemini, label, C2PA, KMS-signed receipt, atomic debit/credit) → verify Licensed → revoke →
 * second render refused → verify Revoked.
 *
 *   pnpm e2e:smoke demo-maya-okafor            image only
 *   pnpm e2e:smoke demo-maya-okafor --video    plus one Veo video (6 s, 720p, about $0.18) and one free fallback video
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { balance, saveBrand, topUp } from "@/lib/server/accounts";
import { firestore } from "@/lib/server/firebase-admin";
import { decide, fileRequest, revoke } from "@/lib/server/licences";
import { renderImage, type RenderDoc } from "@/lib/server/render-image";
import { renderVideo } from "@/lib/server/render-video";
import { getObject } from "@/lib/server/storage";
import { verifyFile } from "@/lib/server/verify";

const creatorId = process.argv[2] ?? "demo-maya-okafor";
const VIDEO = process.argv.includes("--video");
const brand = `smoke-brand-${Date.now().toString(36)}`;
const log = (...a: unknown[]) => console.log(...a);
// The API shape leaves out storage paths, so the file is found through the render's document.
const fileOf = async (renderId: string) => (await getObject(((await firestore().collection("renders").doc(renderId).get()).data() as RenderDoc).object))!;

async function main() {
  await saveBrand(brand, "Brew & Co.", "brewandco.example");
  log("brand", brand, "credits after top-up:", await topUp(brand));
  const req = await fileRequest(brand, { creatorId, use: "advertising", days: 7, maxRenders: 4, brief: "Spring launch of our oat latte: social ads in a sunlit café." });
  const { licence } = await decide(creatorId, req.id, true);
  log("licence", licence!.id, "image price", licence!.pricePerImage);
  const t = Date.now();
  const r = await renderImage(brand, licence!.id, "Smiling in a sunlit café holding a ceramic coffee cup, product shot for a spring campaign", "1:1");
  log("render", r.render.id, `${Date.now() - t} ms`, r.render.model, "price", r.render.price, "creator", r.render.creatorShare, "fee", r.render.fee);
  log("balances: brand", await balance(brand), "creator", await balance(creatorId));
  const file = await fileOf(r.render.id);
  mkdirSync("../.secrets/ai/e2e", { recursive: true });
  writeFileSync("../.secrets/ai/e2e/render.jpg", file);
  const v1 = await verifyFile(new Uint8Array(file), "image/jpeg");
  log("verify:", v1.verdict, "|", v1.headline, "| receipt valid", v1.receipt?.valid, "| c2pa", v1.manifest.present, v1.manifest.signatureValid, "matches", v1.manifest.matchesReceipt);
  if (VIDEO) {
    const tv = Date.now();
    const v = await renderVideo(brand, { licenceId: licence!.id, fromRenderId: r.render.id, prompt: "She lifts the cup toward the camera and smiles, gentle push-in, warm café light", seconds: 6, aspectRatio: "16:9" });
    log("video", v.render.id, `${Date.now() - tv} ms`, v.pipeline, "price", v.render.price, "|", v.note);
    const vf = await fileOf(v.render.id);
    writeFileSync("../.secrets/ai/e2e/video-veo.mp4", vf);
    const vv = await verifyFile(new Uint8Array(vf), "video/mp4");
    log("verify video:", vv.verdict, "|", vv.headline, "| receipt valid", vv.receipt?.valid, "| c2pa", vv.manifest.present, vv.manifest.signatureValid, "matches", vv.manifest.matchesReceipt);
    process.env.VEO_DISABLED = "1";
    const fb = await renderVideo(brand, { licenceId: licence!.id, fromRenderId: r.render.id, prompt: "Spring oat latte, now in store", seconds: 6, aspectRatio: "9:16" });
    delete process.env.VEO_DISABLED;
    log("fallback video", fb.pipeline, "price", fb.render.price, "|", fb.note);
    const ff = await fileOf(fb.render.id);
    writeFileSync("../.secrets/ai/e2e/video-fallback.mp4", ff);
    const fv = await verifyFile(new Uint8Array(ff), "video/mp4");
    log("verify fallback:", fv.verdict, "| receipt valid", fv.receipt?.valid, "| c2pa", fv.manifest.present, fv.manifest.signatureValid);
    log("balances: brand", await balance(brand), "creator", await balance(creatorId));
  }
  const dec = await firestore().collection("decryptions").where("renderId", "==", r.render.id).get();
  log("decryptions logged for this render:", dec.size);
  await revoke(creatorId, licence!.id);
  try {
    await renderImage(brand, licence!.id, "Another café shot", "1:1");
    log("SECOND RENDER WAS NOT REFUSED");
  } catch (e) {
    log("second render refused:", (e as Error).message);
  }
  const v2 = await verifyFile(new Uint8Array(file), "image/jpeg");
  log("verify after revoke:", v2.verdict, "|", v2.headline);
}
main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
