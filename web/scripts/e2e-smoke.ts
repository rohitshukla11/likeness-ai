/**
 * End-to-end check of the licensing pipeline against the real project (one Gemini image, about $0.03):
 * brand profile → demo top-up → request → creator approves → image ad (filter, KMS decrypt logged,
 * Gemini, label, C2PA, KMS-signed receipt, atomic debit/credit) → verify Licensed → revoke →
 * second render refused → verify Revoked.
 *
 *   pnpm e2e:smoke demo-maya-okafor
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { balance, saveBrand, topUp } from "@/lib/server/accounts";
import { firestore } from "@/lib/server/firebase-admin";
import { decide, fileRequest, revoke } from "@/lib/server/licences";
import { renderImage } from "@/lib/server/render-image";
import { getObject } from "@/lib/server/storage";
import { verifyFile } from "@/lib/server/verify";

const creatorId = process.argv[2] ?? "demo-maya-okafor";
const brand = `smoke-brand-${Date.now().toString(36)}`;
const log = (...a: unknown[]) => console.log(...a);

async function main() {
  await saveBrand(brand, "Brew & Co.", "brewandco.example");
  log("brand", brand, "credits after top-up:", await topUp(brand));
  const req = await fileRequest(brand, { creatorId, use: "advertising", days: 7, maxRenders: 2, brief: "Spring launch of our oat latte: social ads in a sunlit café." });
  const { licence } = await decide(creatorId, req.id, true);
  log("licence", licence!.id, "image price", licence!.pricePerImage);
  const t = Date.now();
  const r = await renderImage(brand, licence!.id, "Smiling in a sunlit café holding a ceramic coffee cup, product shot for a spring campaign", "1:1");
  log("render", r.render.id, `${Date.now() - t} ms`, r.render.model, "price", r.render.price, "creator", r.render.creatorShare, "fee", r.render.fee);
  log("balances: brand", await balance(brand), "creator", await balance(creatorId));
  const file = (await getObject(r.render.object))!;
  mkdirSync("../.secrets/ai/e2e", { recursive: true });
  writeFileSync("../.secrets/ai/e2e/render.jpg", file);
  const v1 = await verifyFile(new Uint8Array(file), "image/jpeg");
  log("verify:", v1.verdict, "|", v1.headline, "| receipt valid", v1.receipt?.valid, "| c2pa", v1.manifest.present, v1.manifest.signatureValid, "matches", v1.manifest.matchesReceipt);
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
