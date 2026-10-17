import "server-only";
/**
 * "Try as a demo brand": a temporary brand account without Google sign-in, so anyone can try the
 * brand side (Google only lets listed test users sign in while the OAuth app is in Testing).
 *
 *  - The server mints a Firebase custom token for a fresh uid "demo-brand-…" with the claim demo: true.
 *    It is signed by likeness-demo-signer, a service account with no other access (it can't open
 *    creators' photos); the Cloud Run service account may sign as it.
 *  - A demo brand can license synthetic demo creators only: one licence, at most 3 renders, 1 of them
 *    a video. It can't become a creator.
 *  - Site-wide caps per UTC day bound the spend: demo sessions (and per network address), demo
 *    renders and demo videos. Demo renders also count toward the site's normal daily caps.
 */
import { createHash, randomBytes } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { topUp } from "./accounts";
import { firestore } from "./firebase-admin";
import { requireProject } from "./gcp";
import { HttpError } from "./http";

const n = (v: string | undefined, d: number) => (v ? Number(v) : d);
export const demoLimits = () => ({
  sessionsPerDay: n(process.env.DEMO_SESSIONS_PER_DAY, 30),
  sessionsPerAddress: n(process.env.DEMO_SESSIONS_PER_ADDRESS, 3),
  rendersPerDay: n(process.env.DEMO_RENDERS_PER_DAY, 15),
  videosPerDay: n(process.env.DEMO_VIDEOS_PER_DAY, 3),
  rendersPerLicence: 3,
  videosPerLicence: 1,
});

export const DEMO_BRAND_NAME = "Demo Brand (trial)";
export const isDemoUid = (uid: string) => uid.startsWith("demo-brand-");

const signerEmail = () => process.env.DEMO_SIGNER_SA || `likeness-demo-signer@${requireProject()}.iam.gserviceaccount.com`;
function signerAuth() {
  const app = getApps().find((a) => a.name === "demo-signer") ?? initializeApp({ projectId: requireProject(), serviceAccountId: signerEmail() }, "demo-signer");
  return getAuth(app);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Start a demo brand session: caps checked and counted, account created, a sign-in token returned. */
export async function startDemoBrand(address: string): Promise<{ token: string; uid: string }> {
  const db = firestore();
  const lim = demoLimits();
  const day = today();
  // The address is only ever stored hashed with the day, to count sessions per network.
  const addr = createHash("sha256").update(`${day}|${address}`).digest("hex").slice(0, 24);
  await db.runTransaction(async (tx) => {
    const uref = db.collection("usage").doc(day);
    const aref = db.collection("demoAddresses").doc(`${day}-${addr}`);
    const [u, a] = await Promise.all([tx.get(uref), tx.get(aref)]);
    if (Number(u.data()?.demoSessions ?? 0) >= lim.sessionsPerDay) throw new HttpError(429, "Today's demo brands are all taken. Try again after 00:00 UTC, or sign in with Google.");
    if (Number(a.data()?.count ?? 0) >= lim.sessionsPerAddress) throw new HttpError(429, "You've started the most demo brands allowed from this network today. Use the one you have, or sign in with Google.");
    tx.set(uref, { demoSessions: FieldValue.increment(1) }, { merge: true });
    tx.set(aref, { count: FieldValue.increment(1), day }, { merge: true });
  });
  const uid = `demo-brand-${randomBytes(9).toString("base64url")}`;
  const now = Date.now();
  await Promise.all([
    db.collection("users").doc(uid).set({ uid, role: "brand", name: "Demo brand", email: null, demo: true, createdAt: now }),
    db.collection("brands").doc(uid).set({ uid, name: DEMO_BRAND_NAME, website: "", demo: true, createdAt: now, updatedAt: now }),
  ]);
  await topUp(uid);
  const token = await signerAuth().createCustomToken(uid, { demo: true });
  return { token, uid };
}
