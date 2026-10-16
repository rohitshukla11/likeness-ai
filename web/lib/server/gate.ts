import "server-only";
/**
 * The video quality gate, run on every video before it is labelled or charged:
 *   sample 6 frames evenly → YuNet: is a face fully inside each frame (box and headroom inside the
 *   edges, all five landmarks inside)? → AuraFace: does that face match the creator's reference
 *   frames (best cosine similarity) at or above the threshold?
 * It passes when a majority of frames (4 of 6) show a fully visible face AND a majority match.
 */
import { analyseFaces, cosine, type Face } from "./facematch";
import { sampleFrames } from "./motion";

export const GATE_FRAMES = 6;
/**
 * Generated frames match their source less closely than live photos do, so the gate has its own
 * threshold. Calibrated 2026-10-17 (small sample): a Veo 3.1 Lite video of a demo creator scored
 * 0.43–0.55 against her references, and the Gemini still it started from scored 0.57; a real person
 * against invented faces scored at most 0.24 (facematch.ts). 0.35 sits between the two.
 */
export const gateThreshold = () => Number(process.env.GATE_FACE_MATCH_THRESHOLD ?? 0.35);

export type FrameCheck = { face: boolean; fullyVisible: boolean; similarity: number | null };

export type GateAttempt = {
  passed: boolean;
  frames: number;
  visible: number;
  matched: number;
  need: number;
  threshold: number;
  medianSimilarity: number | null;
  minSimilarity: number | null;
  /** Face boxes seen in the frames, as fractions of the frame, for placing the label. */
  faces: { x: number; y: number; w: number; h: number }[];
  reason: string;
};

/** Stored on the render: the delivered video's check (for a fallback, the fallback's own), and each Veo attempt. */
export type GateRecord = Omit<GateAttempt, "faces"> & { attempts: Omit<GateAttempt, "faces">[]; outcome: "passed" | "passed on retry" | "failed, fallback used" | "Veo unavailable, fallback used" };

/** A face is fully visible when its box, with a little headroom, and its landmarks are inside the frame. */
export function fullyVisible(f: Pick<Face, "box" | "landmarks">, W: number, H: number): boolean {
  const [x, y, w, h] = f.box;
  const inBox = x >= 0 && y - h * 0.1 >= 0 && x + w <= W && y + h <= H;
  const inMarks = f.landmarks.every(([lx, ly]) => lx >= 0 && ly >= 0 && lx <= W && ly <= H);
  return inBox && inMarks;
}

export function gateVerdict(frames: FrameCheck[], threshold: number): Omit<GateAttempt, "faces"> {
  const n = frames.length;
  const need = Math.floor(n / 2) + 1;
  const visible = frames.filter((f) => f.fullyVisible).length;
  const sims = frames.filter((f) => f.fullyVisible && f.similarity !== null).map((f) => f.similarity!);
  const matched = sims.filter((s) => s >= threshold).length;
  const sorted = [...sims].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const passed = n > 0 && visible >= need && matched >= need;
  const reason = passed
    ? `face fully visible in ${visible}/${n} frames, matches the creator in ${matched}/${n}`
    : visible < need
      ? `the face was fully visible in only ${visible} of ${n} frames (needs ${need})`
      : `the face matched the creator in only ${matched} of ${n} frames (needs ${need}, threshold ${threshold})`;
  const r2 = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  return { passed, frames: n, visible, matched, need, threshold, medianSimilarity: r2(median), minSimilarity: r2(sorted[0] ?? null), reason };
}

/** Run the gate on a video. `refs` are the creator's reference embeddings; `span` skips any end-card. */
export async function runGate(mp4: Uint8Array, refs: Float32Array[], span: number): Promise<GateAttempt> {
  const frames = await sampleFrames(mp4, GATE_FRAMES, span);
  const checks: FrameCheck[] = [];
  const faces: GateAttempt["faces"] = [];
  for (const f of frames) {
    const a = await analyseFaces(f, { embed: true });
    const best = a.faces[0];
    if (best) faces.push({ x: best.box[0] / a.width, y: best.box[1] / a.height, w: best.box[2] / a.width, h: best.box[3] / a.height });
    const similarity = a.embedding && refs.length ? Math.max(...refs.map((r) => cosine(r, a.embedding!))) : null;
    checks.push({ face: !!best, fullyVisible: !!best && fullyVisible(best, a.width, a.height), similarity });
    a.embedding?.fill(0);
  }
  return { ...gateVerdict(checks, gateThreshold()), faces };
}
