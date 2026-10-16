import { firestore } from "@/lib/server/firebase-admin";
import { docId, HttpError } from "@/lib/server/http";
import { authed } from "@/lib/server/route";
import type { RenderDoc } from "@/lib/server/render-image";
import { getObject, signedUrl } from "@/lib/server/storage";

/**
 * A 15-minute V4 signed URL for a render, for the brand that paid for it or the creator in it.
 * Locally (user credentials can't sign) the bytes come back inline instead.
 */
export const GET = authed<{ id: string }>(async (_req, me, p) => {
  const s = await firestore().collection("renders").doc(docId(p.id)).get();
  const r = s.data() as RenderDoc | undefined;
  if (!r) throw new HttpError(404, "no such render");
  if (r.brandId !== me.uid && r.creatorId !== me.uid) throw new HttpError(403, "not your render");
  try {
    return { url: await signedUrl(r.object), mime: r.mime, expiresInMinutes: 15 };
  } catch {
    const b = await getObject(r.object);
    if (!b) throw new HttpError(404, "file missing");
    return { url: `data:${r.mime};base64,${b.toString("base64")}`, mime: r.mime, inline: true };
  }
});
