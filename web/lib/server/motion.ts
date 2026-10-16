import "server-only";
/**
 * ffmpeg for video ads (system ffmpeg in the container; FFMPEG_PATH locally):
 *  - labelVideo: burn the visible "AI-generated · licensed likeness" label into a video;
 *  - motionAd: the free fallback when Veo refuses or fails: a slow zoom-and-pan over the licensed
 *    still with a caption, then a brand end-card. H.264 MP4, 720p, 24 fps, silent.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { LABEL_AI_RENDER } from "./watermarks";

export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(/*turbopackIgnore: true*/ ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`ffmpeg not available: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.slice(-400)}`))));
  });
}

export async function ffmpegAvailable(): Promise<boolean> {
  return run(["-version"]).then(
    () => true,
    () => false,
  );
}

async function inTmp<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "likeness-video-"));
  try {
    return await f(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A poster frame (JPEG, 480 px wide) from about a second into the video. */
export async function posterFrame(mp4: Uint8Array): Promise<Uint8Array> {
  return inTmp(async (dir) => {
    await writeFile(path.join(dir, "in.mp4"), mp4);
    await run(["-ss", "1", "-i", path.join(dir, "in.mp4"), "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", path.join(dir, "poster.jpg")]);
    return new Uint8Array(await readFile(path.join(dir, "poster.jpg")));
  });
}

/** Burn the label in, bottom-right, at the same share of the width as on images. */
export async function labelVideo(mp4: Uint8Array, width: number): Promise<Uint8Array> {
  return inTmp(async (dir) => {
    const w = Math.round(width * 0.42);
    await writeFile(path.join(dir, "in.mp4"), mp4);
    await writeFile(path.join(dir, "label.png"), await sharp(LABEL_AI_RENDER).resize({ width: w }).png().toBuffer());
    const m = Math.round(width * 0.025);
    await run(["-i", path.join(dir, "in.mp4"), "-i", path.join(dir, "label.png"), "-filter_complex", `[0:v][1:v]overlay=W-w-${m}:H-h-${m}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path.join(dir, "out.mp4")]);
    return new Uint8Array(await readFile(path.join(dir, "out.mp4")));
  });
}

/** The free fallback: zoom and pan over the still with a caption, then a brand end-card. */
export async function motionAd(input: { still: Uint8Array; caption: string; brand: string; aspectRatio: "16:9" | "9:16"; seconds: number }): Promise<Uint8Array> {
  const [W, H] = input.aspectRatio === "16:9" ? [1280, 720] : [720, 1280];
  const fps = 24;
  const main = Math.max(3, input.seconds - 2);
  return inTmp(async (dir) => {
    // A larger canvas than the output, so zoompan has room to move.
    await writeFile(path.join(dir, "still.jpg"), await sharp(input.still).rotate().resize(W * 2, H * 2, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer());
    const caption = input.caption.length > 70 ? `${input.caption.slice(0, 67).trimEnd()}…` : input.caption;
    const fs = Math.round(W / 26);
    const captionSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${fs * 3}"><rect width="100%" height="100%" fill="#121316" fill-opacity="0.55"/><text x="50%" y="62%" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fs}" font-weight="700" fill="#ffffff">${esc(caption)}</text></svg>`;
    await writeFile(path.join(dir, "caption.png"), await sharp(Buffer.from(captionSvg)).png().toBuffer());
    const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#121316"/><circle cx="${W / 2}" cy="${H / 2 - fs * 2.2}" r="${fs * 0.7}" fill="#D4F36A"/><text x="50%" y="${H / 2 + fs * 0.6}" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fs * 2}" font-weight="700" fill="#ffffff">${esc(input.brand)}</text><text x="50%" y="${H / 2 + fs * 2.4}" text-anchor="middle" font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${Math.round(fs * 0.75)}" fill="#c8cbd0">AI-generated ad · licensed likeness</text></svg>`;
    await writeFile(path.join(dir, "card.png"), await sharp(Buffer.from(cardSvg)).png().toBuffer());
    const frames = main * fps;
    await run([
      // The still is read once: zoompan turns that single frame into exactly `frames` frames.
      "-i", path.join(dir, "still.jpg"),
      "-i", path.join(dir, "caption.png"),
      "-loop", "1", "-t", "2", "-i", path.join(dir, "card.png"),
      "-filter_complex",
      [
        `[0:v]zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)+on*0.6':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${fps},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[zp]`,
        `[zp][1:v]overlay=0:H-h-${Math.round(H * 0.06)}:enable='gte(t,0.6)'[cap]`,
        `[2:v]scale=${W}:${H},fps=${fps},format=yuv420p,fade=t=in:st=0:d=0.4[card]`,
        `[cap][card]concat=n=2:v=1:a=0[v]`,
      ].join(";"),
      "-map", "[v]", "-t", String(main + 2), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      path.join(dir, "ad.mp4"),
    ]);
    return new Uint8Array(await readFile(path.join(dir, "ad.mp4")));
  });
}
