import { firestore } from "@/lib/server/firebase-admin";
import { authed } from "@/lib/server/route";
import type { RenderDoc } from "@/lib/server/render-image";

/** Renders I paid for (brand) or that used my likeness (creator). */
export const GET = authed(async (_req, me) => {
  const [b, c] = await Promise.all([
    firestore().collection("renders").where("brandId", "==", me.uid).limit(100).get(),
    firestore().collection("renders").where("creatorId", "==", me.uid).limit(100).get(),
  ]);
  const newest = (x: RenderDoc, y: RenderDoc) => y.createdAt - x.createdAt;
  return { asBrand: b.docs.map((d) => d.data() as RenderDoc).sort(newest), asCreator: c.docs.map((d) => d.data() as RenderDoc).sort(newest) };
});
