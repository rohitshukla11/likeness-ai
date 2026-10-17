import { startDemoBrand } from "@/lib/server/demo";
import { route } from "@/lib/server/route";

/** "Try as a demo brand": no sign-in needed; returns a token the browser signs in with. */
export const POST = route(async (req) => {
  // Cloud Run puts the client address first in X-Forwarded-For.
  const address = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const { token } = await startDemoBrand(address);
  return { token };
});
