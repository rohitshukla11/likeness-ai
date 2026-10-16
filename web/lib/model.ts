/**
 * The data model, shared by server and browser. Stored in Firestore (database FIRESTORE_DATABASE):
 *   users/{uid}           role, name, email
 *   creators/{uid}        channel, face match, consent, terms, listing, wrapped data key
 *   brands/{uid}          brand name and website
 *   credits/{uid}         demo-credit balance; ledger/{id} every debit and credit
 *   requests/{id}         a brand's licence request, pending until the creator decides
 *   licences/{id}         an approved licence: use, period, render cap, prices, status
 *   renders/{id}          one paid render; receipts/{sha256} its KMS-signed receipt
 *   decryptions/{id}      every time the render service opened a creator's photos
 * Prices are in demo credits (1 credit = US$0.01, not real money).
 */
import { CATEGORIES } from "./categories";

export type Role = "creator" | "brand";

export type Channel = {
  channelId: string;
  title: string;
  avatarUrl: string;
  subscriberCount: number | null; // null when the channel hides it
  connectedAt: number;
};

export type Terms = {
  uses: string[]; // category keys (advertising, social, …)
  pricePerImage: number; // demo credits
  pricePerVideo: number;
  maxRendersPerLicence: number;
  maxDays: number;
  approval: "manual";
  /** Whether brands may make video ads (Veo) from licensed stills, and how many per licence. */
  videoAllowed: boolean;
  maxVideosPerLicence: number;
};

export type CreatorDoc = {
  uid: string;
  status: "draft" | "live";
  displayName: string;
  channel?: Channel;
  faceMatch?: { score: number; threshold: number; framesMatched: number; at: number };
  liveness?: { blinks: number; turnedLeft: boolean; turnedRight: boolean; method: "mediapipe-face-landmarker"; at: number };
  frames?: { count: number; sealedAt: number; sha256: string[] };
  wrappedKey?: string; // the creator's data key, wrapped by Cloud KMS
  adultSelfDeclared?: { at: number };
  consent?: { at: number; text: string };
  terms?: Terms;
  listed: boolean;
  publicPhoto?: boolean;
  /** Synthetic demo creator (generated face, no YouTube channel), labelled everywhere. */
  demo?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type LicenceStatus = "Active" | "Expired" | "Revoked" | "Exhausted";

export type RequestDoc = {
  id: string;
  brandId: string;
  brandName: string;
  creatorId: string;
  use: string; // one category key
  days: number;
  maxRenders: number;
  brief: string;
  state: "pending" | "approved" | "declined";
  licenceId?: string;
  createdAt: number;
  decidedAt?: number;
};

export type LicenceDoc = {
  id: string;
  requestId: string;
  brandId: string;
  brandName: string;
  creatorId: string;
  creatorName: string;
  use: string;
  start: number;
  end: number;
  maxRenders: number;
  renderCount: number;
  pricePerImage: number;
  pricePerVideo: number;
  videoAllowed: boolean;
  maxVideos: number;
  videoCount: number;
  revokedAt?: number;
  createdAt: number;
};

export type RenderType = "image" | "video";

export type ReceiptPayload = {
  v: 1;
  contentSha256: string;
  mime: string;
  licenceId: string;
  creatorId: string;
  brandId: string;
  use: string;
  renderType: RenderType;
  renderIndex: number;
  model: string;
  price: number;
  createdAt: number;
  /** Video only: which pipeline made it, and the licensed still it started from. */
  pipeline?: "veo-3.1-lite" | "ffmpeg-fallback";
  fromRenderId?: string;
};

export const FEE_PERCENT = 10;
export const DEMO_TOPUP = 2_000; // credits per top-up click
export const DEMO_TOPUP_CAP = 20_000; // a brand's balance can't be topped up past this

/** Default prices from audience size: bigger channels cost more per image. Video is 4× an image. */
export function audiencePrice(subscribers: number | null): { image: number; video: number } {
  const s = subscribers ?? 0;
  const image = s >= 1_000_000 ? 1_000 : s >= 100_000 ? 500 : s >= 10_000 ? 200 : s >= 1_000 ? 100 : 50;
  return { image, video: image * 4 };
}

export function defaultTerms(subscribers: number | null): Terms {
  const p = audiencePrice(subscribers);
  return { uses: ["advertising", "social"], pricePerImage: p.image, pricePerVideo: p.video, maxRendersPerLicence: 10, maxDays: 30, approval: "manual", videoAllowed: true, maxVideosPerLicence: 3 };
}

export function licenceStatus(l: Pick<LicenceDoc, "revokedAt" | "end" | "renderCount" | "maxRenders">, now = Date.now()): LicenceStatus {
  if (l.revokedAt) return "Revoked";
  if (now >= l.end) return "Expired";
  if (l.renderCount >= l.maxRenders) return "Exhausted";
  return "Active";
}

export const useLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;

export function creatorFee(price: number): { creator: number; fee: number } {
  const fee = Math.floor((price * FEE_PERCENT) / 100);
  return { creator: price - fee, fee };
}

/** Why a video can't be made under this licence right now, or null. Pure, so the UI and server agree. */
export function videoRefusal(l: Pick<LicenceDoc, "videoAllowed" | "maxVideos" | "videoCount">, videosToday: number, perDay: number): string | null {
  if (!l.videoAllowed) return "this creator doesn't allow video ads under this licence";
  if ((l.videoCount ?? 0) >= l.maxVideos) return `this licence's video limit (${l.maxVideos}) is used up`;
  if (videosToday >= perDay) return `the site's daily video limit (${perDay}) is reached; try again after 00:00 UTC`;
  return null;
}

export const credits = (n: number) => `${n.toLocaleString("en-US")} credits`;

export function subscriberLabel(n: number | null): string {
  if (n === null) return "subscriber count hidden";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M subscribers`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K subscribers`;
  return `${n} subscriber${n === 1 ? "" : "s"}`;
}

export const CONSENT_TEXT =
  "I am 18 or older (self-declared). I license my likeness to brands that I approve one by one, for the uses and prices in my terms. Each image or video made under a licence is labelled AI-generated, carries a content credential and a signed receipt. I can revoke any licence at any time; new renders are then refused.";
