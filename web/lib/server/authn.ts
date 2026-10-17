import "server-only";
/** Who is calling: a Firebase ID token in "Authorization: Bearer …", verified with Firebase Admin. */
import { adminAuth } from "./firebase-admin";
import { HttpError } from "./http";

/** demo: a temporary demo brand (lib/server/demo.ts), signed in with a server-minted token. */
export type Caller = { uid: string; email: string | null; name: string | null; picture: string | null; demo: boolean };

export async function requireUser(req: Request): Promise<Caller> {
  const h = req.headers.get("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw new HttpError(401, "sign in first");
  try {
    const t = await adminAuth().verifyIdToken(token);
    return { uid: t.uid, email: t.email ?? null, name: (t.name as string | undefined) ?? null, picture: (t.picture as string | undefined) ?? null, demo: t.demo === true || t.uid.startsWith("demo-brand-") };
  } catch {
    throw new HttpError(401, "your sign-in has expired; sign in again");
  }
}

/** Refuse a demo brand where only a real, signed-in Google account may act. */
export function forbidDemo(me: Caller, what: string) {
  if (me.demo) throw new HttpError(403, `A demo brand can't ${what}. Sign in with Google to do that.`);
}
