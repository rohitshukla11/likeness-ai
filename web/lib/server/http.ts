import "server-only";

export const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** Map any thrown error to a JSON response; errors with a numeric `status` keep it. */
export function fail(e: unknown) {
  const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 500;
  const message = e instanceof Error ? e.message : "failed";
  if (status >= 500) console.error(JSON.stringify({ service: "api", error: message.slice(0, 500) }));
  return json({ error: message }, status);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A Firestore document id we generated (or a Firebase uid): letters, digits, - and _. */
export function docId(v: string | null | undefined, name = "id"): string {
  if (!v || !/^[A-Za-z0-9_-]{6,128}$/.test(v)) throw new HttpError(400, `bad ${name}`);
  return v;
}
