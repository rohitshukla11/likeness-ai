import "server-only";
/**
 * Prompt check before any render. Two layers:
 *  1. Local rules, always: keyword and phrase rules for the five banned uses (political, adult,
 *     minors, impersonation, deception). Cheap, deterministic, and blunt.
 *  2. A Gemini classifier (gemini-3.5-flash-lite on Vertex AI) with structured JSON output: banned-use
 *     judgement plus whether the prompt fits the licence's one licensed category. If the call fails,
 *     the render is refused (fail closed), never waved through.
 * Without a Google Cloud project configured, the result says "LLM filter not configured" and only the rules ran.
 */
import { BANNED, CATEGORIES } from "@/lib/categories";
import { generateContent, geminiModels, vertexConfigured } from "./gemini";

export type FilterResult = {
  allowed: boolean;
  reasons: string[];
  layers: { name: string; ran: boolean; note?: string }[];
};

type Rule = { key: (typeof BANNED)[number]["key"]; patterns: RegExp[] };

const w = (words: string) => new RegExp(`\\b(?:${words})\\b`, "i");

export const RULES: Rule[] = [
  {
    key: "political",
    patterns: [
      w("election|elections|vote for|voting for|ballot|candidate|campaign rally|political|politician|senator|congress(?:man|woman)?|parliament|prime minister|president(?:ial)?|democrat|republican|party manifesto|referendum|propaganda"),
    ],
  },
  {
    key: "adult",
    patterns: [w("nude|nudity|naked|topless|nsfw|porn\\w*|sexual|sexy|erotic|explicit|lingerie|fetish|onlyfans|strip(?:per|tease)|undress\\w*")],
  },
  {
    key: "minors",
    patterns: [w("child|children|kid|kids|minor|minors|underage|teen|teenage|teenager|schoolgirl|schoolboy|toddler|baby|infant|preteen|young girl|young boy|\\d{1,2}[- ]?year[- ]?old")],
  },
  {
    key: "impersonation",
    patterns: [
      w("pretend(?:ing)? to be|posing as|impersonat\\w*|as if (?:she|he|they) (?:were|was) (?:a )?(?:celebrity|famous)|official statement from|on behalf of|endorsed by|signature of"),
    ],
  },
  {
    key: "deception",
    patterns: [
      w("deepfake|fake news|hoax|scam|fraud\\w*|misinformation|disinformation|fake (?:testimonial|review|evidence|receipt|id|document)|crime scene|mugshot|arrest\\w*|confess\\w*|caught (?:doing|stealing)|real footage"),
    ],
  },
];

export function ruleCheck(prompt: string): string[] {
  const hits: string[] = [];
  for (const r of RULES) {
    const m = r.patterns.map((p) => p.exec(prompt)).find(Boolean);
    if (m) hits.push(`${BANNED.find((b) => b.key === r.key)!.label}: “${m[0]}”`);
  }
  return hits;
}

const FILTER_INSTRUCTION = `You screen prompts for an image generator that renders a real, consenting adult's likeness under a licence.
Banned uses, never allowed under any licence:
- political: elections, candidates, parties, policy advocacy;
- adult: sexual or sexualised content, nudity;
- minors: anything involving minors or a childlike depiction;
- impersonation: presenting the person as someone else, or as endorsing or saying something they did not;
- deception: fake news, fake evidence, fake testimonials, depicting crimes or events as real.
The licence covers exactly one use category. Decide whether the prompt fits it.
Return JSON matching the schema.`;

// JSON Schema for generationConfig.responseJsonSchema (responseSchema is deprecated).
const FILTER_SCHEMA = {
  type: "object",
  properties: {
    banned: { type: "array", items: { type: "string", enum: ["political", "adult", "minors", "impersonation", "deception"] } },
    fitsCategory: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["banned", "fitsCategory", "reason"],
};

async function geminiCheck(prompt: string, category: string): Promise<{ banned: string[]; fitsCategory: boolean; reason: string }> {
  const res = await generateContent(
    geminiModels.filter(),
    {
      systemInstruction: { parts: [{ text: FILTER_INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: `Licence category: ${category}\nPrompt: ${prompt}` }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseJsonSchema: FILTER_SCHEMA },
    },
    20_000,
  );
  if (res.promptFeedback?.blockReason) return { banned: ["blocked by Gemini safety"], fitsCategory: false, reason: res.promptFeedback.blockReason };
  const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const out = JSON.parse(text);
  if (!Array.isArray(out.banned) || typeof out.fitsCategory !== "boolean") throw new Error("Gemini filter returned an unexpected shape");
  return { banned: out.banned.map(String), fitsCategory: out.fitsCategory, reason: String(out.reason ?? "") };
}

export async function checkPrompt(prompt: string, categoryBit: number): Promise<FilterResult> {
  const category = CATEGORIES.find((c) => c.bit === categoryBit)?.label ?? "unknown";
  const reasons: string[] = [];
  const layers: FilterResult["layers"] = [];

  if (prompt.trim().length < 3) reasons.push("prompt is empty");
  if (prompt.length > 2000) reasons.push("prompt is longer than 2000 characters");
  const hits = ruleCheck(prompt);
  reasons.push(...hits.map((h) => `banned use (rules) — ${h}`));
  layers.push({ name: "Local banned-use rules", ran: true });

  if (vertexConfigured()) {
    try {
      const q = await geminiCheck(prompt, category);
      for (const b of q.banned) reasons.push(`banned use (Gemini) — ${b}: ${q.reason}`);
      if (!q.fitsCategory) reasons.push(`outside the licensed use (${category}) — ${q.reason}`);
      layers.push({ name: `Gemini LLM filter (${geminiModels.filter()})`, ran: true });
    } catch (e) {
      reasons.push(`LLM filter failed, so the render is refused: ${(e as Error).message}`);
      layers.push({ name: "Gemini LLM filter", ran: false, note: "call failed (fail closed)" });
    }
  } else {
    layers.push({ name: "LLM filter", ran: false, note: `LLM filter not configured (GOOGLE_CLOUD_PROJECT): rules only; fit with the licensed use (${category}) not checked` });
  }
  return { allowed: reasons.length === 0, reasons, layers };
}
