/**
 * Synthetic demo creators: fictional adults generated with Gemini on Vertex AI, never real people,
 * labelled "synthetic demo creator" everywhere (demo: true, no YouTube channel). Their three reference
 * frames go through the same KMS envelope encryption as a real creator's.
 *
 *   pnpm seed:demo "Ana Reyes" "warm smile, curly dark hair, olive skin, late twenties"
 */
import { firestore } from "@/lib/server/firebase-admin";
import { generateContent, geminiModels } from "@/lib/server/gemini";
import { publicPhoto } from "@/lib/server/label";
import { putObject } from "@/lib/server/storage";
import { sealFrames } from "@/lib/server/vault";
import { defaultTerms, type CreatorDoc } from "@/lib/model";
import sharp from "sharp";

const [name, looks] = process.argv.slice(2);
if (!name || !looks) throw new Error('usage: pnpm seed:demo "Display name" "appearance"');

async function image(parts: unknown[]): Promise<Uint8Array> {
  const r = await generateContent(geminiModels.image(), { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "1:1" } } });
  const p = r.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data && !x.thought)?.inlineData;
  if (!p) throw new Error(`no image: ${r.candidates?.[0]?.finishReason ?? r.promptFeedback?.blockReason}`);
  return new Uint8Array(await sharp(Buffer.from(p.data, "base64")).jpeg({ quality: 90 }).toBuffer());
}

async function main() {
  const base = `Photorealistic head-and-shoulders portrait of a fictional adult, not resembling any real person: ${looks}. Plain light background, soft even light, neutral friendly expression, like a passport-style reference photo.`;
  const front = await image([{ text: `${base} Facing the camera directly.` }]);
  const turn = (side: string) => image([{ inlineData: { mimeType: "image/jpeg", data: Buffer.from(front).toString("base64") } }, { text: `The same fictional person as in this image, same face, hair, clothes, background and light, with their head turned slightly to their ${side}, about 15 degrees.` }]);
  const frames = [front, await turn("left"), await turn("right")];
  const uid = `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  const sealed = await sealFrames(uid, frames);
  await putObject(`public/${uid}.jpg`, await publicPhoto(frames[0]), "image/jpeg");
  const now = Date.now();
  const doc: CreatorDoc = {
    uid,
    status: "live",
    displayName: name,
    demo: true,
    listed: true,
    publicPhoto: true,
    wrappedKey: sealed.wrappedKey,
    frames: { count: 3, sealedAt: now, sha256: sealed.sha256 },
    consent: { at: now, text: "Synthetic demo creator: a generated face, not a real person." },
    terms: defaultTerms(25_000),
    createdAt: now,
    updatedAt: now,
  };
  await firestore().collection("creators").doc(uid).set(doc);
  console.log(`seeded ${uid} (${name}): 3 frames sealed with KMS, public photo stored, listed`);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
