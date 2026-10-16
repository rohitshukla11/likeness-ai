import { authed, body } from "@/lib/server/route";
import { renderVideo } from "@/lib/server/render-video";

// Veo takes about a minute, and a failed quality gate retries once: allow 10 (Cloud Run timeout is 600 s).
export const maxDuration = 600;

export const POST = authed(async (req, me) => {
  const b = await body<{ licenceId: string; fromRenderId: string; prompt: string; seconds?: number; aspectRatio?: string; resolution?: string }>(req);
  return renderVideo(me.uid, {
    licenceId: String(b.licenceId),
    fromRenderId: String(b.fromRenderId),
    prompt: String(b.prompt ?? ""),
    seconds: b.seconds === 8 ? 8 : 6,
    aspectRatio: b.aspectRatio === "9:16" ? "9:16" : "16:9",
    resolution: b.resolution === "1080p" ? "1080p" : "720p",
  });
});
