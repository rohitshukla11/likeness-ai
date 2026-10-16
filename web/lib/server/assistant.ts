import "server-only";
/**
 * The creative assistant: a brand's short inputs → a detailed, editable ad prompt (and, for video,
 * a motion prompt), written by Gemini on Vertex AI (the safety filter's text model). Text only; free.
 *
 * Safety, in order:
 *  1. the brand's inputs go through the banned-use rules first; a hit is refused before any model call;
 *  2. Gemini is told the licence's one allowed use, the banned uses, and never to name the person or
 *     write claims, quotes or endorsements for them; it can refuse, and a refusal is passed on;
 *  3. the draft goes through the banned-use rules again; a hit is refused, never returned;
 *  4. the creator's name is never sent; if a name still appears it is replaced with "the person".
 * The draft is only a suggestion: every render still runs the full safety filter on what is submitted.
 */
import { CATEGORIES } from "@/lib/categories";
import { ASPECT_GUIDANCE, FRAMING_RULES, MOODS, MOTION_RULES, type AssistantDraft, type AssistantInput, type PromptDetails } from "@/lib/creative";
import { ruleCheck } from "./filter";
import { generateContent, geminiModels, vertexConfigured } from "./gemini";
import { HttpError } from "./http";

export class AssistantRefused extends HttpError {}

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Normalise untrusted inputs: short strings, known enums only. */
export function cleanInput(raw: Partial<Record<keyof AssistantInput, unknown>>): AssistantInput {
  const format = raw.format === "video" ? "video" : "image";
  let aspect: AssistantInput["aspect"] = raw.aspect === "16:9" || raw.aspect === "9:16" ? raw.aspect : "1:1";
  if (format === "video" && aspect === "1:1") aspect = "16:9";
  return {
    idea: clip(raw.idea, 120),
    product: clip(raw.product, 80),
    setting: clip(raw.setting, 100),
    mood: MOODS.includes(raw.mood as never) ? (raw.mood as AssistantInput["mood"]) : "warm",
    aspect,
    format,
  };
}

const INSTRUCTION = (useLabel: string) => `You write prompts for an AI ad generator that renders a real, consenting adult under a likeness licence.
The licence allows exactly one use: ${useLabel}. Write only prompts for that use. If the brand's request needs another use, set refused to true and explain.
Never write, under any licence (set refused to true instead):
- political content (elections, candidates, parties, causes);
- adult, sexual or revealing content;
- anything involving minors or a childlike depiction;
- impersonation: presenting the person as someone else;
- deception: fake news, fake evidence, fake reviews or testimonials, staged real events;
- claims that the person personally uses, recommends or endorses anything, quotes, speech or statements attributed to them.
Refer to the person only as "the person". Never use or invent a name, job, age, nationality or biography.
The product appears in the ad; the person is shown with it, nothing more is claimed.
Wardrobe: neutral and on-brand, never revealing.
Framing (the server also appends these rules to every render, so describe them briefly in your own words, never copy them): ${FRAMING_RULES}
Fields: subject = who and the framing, e.g. "Medium close-up of the person, full head and face visible with headroom, eyes in the upper third, looking toward the camera, natural expression"; action = what the person does with the product, e.g. "holding a ceramic coffee cup at chest height, label facing the camera"; setting = place and lighting, e.g. "sunlit café, soft window light from the left, shallow depth of field"; wardrobe; composition = headline space, product visibility and the aspect guidance; style = "photorealistic commercial photography, natural skin tones, high detail" plus the mood.
Return JSON matching the schema. brief is the complete still prompt as one paragraph (at most 900 characters) built from the details, starting with the subject.
For a video ad, motion says what happens on screen in one or two sentences: first the person's specific action with the product (for example "the person lifts the cup toward the camera and smiles warmly"), then a subtle camera move, keeping the full face in frame. For an image ad, motion is an empty string.`;

const SCHEMA = {
  type: "object",
  properties: {
    refused: { type: "boolean" },
    refusalReason: { type: "string" },
    subject: { type: "string" },
    action: { type: "string" },
    setting: { type: "string" },
    wardrobe: { type: "string" },
    composition: { type: "string" },
    style: { type: "string" },
    brief: { type: "string" },
    motion: { type: "string" },
  },
  required: ["refused", "refusalReason", "subject", "action", "setting", "wardrobe", "composition", "style", "brief", "motion"],
};

const MOOD_LIGHT: Record<AssistantInput["mood"], string> = {
  warm: "soft warm window light from the left, shallow depth of field, gentle golden tones",
  energetic: "bright natural daylight, crisp contrast, vivid but natural colours",
  premium: "controlled soft key light with subtle rim light, refined muted palette",
  playful: "bright, even light, cheerful saturated accents",
};

/** The deterministic draft: used when Gemini isn't configured or fails, and as the shape Gemini fills. */
export function templateDraft(input: AssistantInput, useLabel: string): AssistantDraft {
  const product = input.product || "the product";
  const setting = input.setting || "a clean, bright interior";
  const details: PromptDetails = {
    subject: "Medium close-up of the person, full head and face visible with headroom, eyes in the upper third, looking toward the camera, natural expression.",
    action: `Holding ${product} at chest height, label facing the camera${input.idea ? `, for a ${input.idea}` : ""}.`,
    setting: `${setting[0].toUpperCase()}${setting.slice(1)}, ${MOOD_LIGHT[input.mood]}.`,
    wardrobe: "Neutral, on-brand casual clothing; nothing revealing.",
    composition: `Clean space for a headline, ${product} clearly visible. ${ASPECT_GUIDANCE[input.aspect]}`,
    style: `Photorealistic commercial photography for ${useLabel.toLowerCase()}, natural skin tones, high detail, ${input.mood} mood.`,
  };
  const motion =
    input.format === "video"
      ? `Subtle slow camera push-in; the person lifts ${product} slightly and smiles warmly; natural relaxed movement; the full face stays in frame and well lit; keep identity unchanged; no text or logos generated.`
      : null;
  return { brief: briefFrom(details), details, motion, aspect: input.aspect, format: input.format, source: "template" };
}

const briefFrom = (d: PromptDetails) => [d.subject, d.action, d.setting, d.wardrobe, d.composition, d.style].join(" ");

/** Replace the creator's name (full or first) if the model wrote it anyway. */
export function withoutName(text: string, name: string | undefined): string {
  const parts = (name ?? "").split(/\s+/).filter((p) => p.length >= 3);
  let out = text;
  for (const p of [name ?? "", ...parts].filter((p) => p.length >= 3)) out = out.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "the person");
  return out;
}

export async function writePrompt(opts: { input: AssistantInput; use: string; creatorName?: string; regenerate?: boolean }): Promise<AssistantDraft> {
  const { input } = opts;
  const useLabel = CATEGORIES.find((c) => c.key === opts.use)?.label ?? opts.use;
  const asked = [input.idea, input.product, input.setting].join(" · ");
  const inHits = ruleCheck(asked);
  if (inHits.length) throw new AssistantRefused(422, `The assistant won't write this: banned use — ${inHits.join("; ")}`);

  let draft: AssistantDraft;
  if (!vertexConfigured()) {
    draft = { ...templateDraft(input, useLabel), note: "Written from the template (Gemini isn't configured here)." };
  } else {
    try {
      draft = await geminiDraft(input, useLabel, !!opts.regenerate);
    } catch (e) {
      if (e instanceof AssistantRefused) throw e;
      draft = { ...templateDraft(input, useLabel), note: `Written from the template: Gemini was unavailable (${(e as Error).message.slice(0, 120)}).` };
    }
  }

  const clean = (s: string) => withoutName(s, opts.creatorName);
  draft = {
    ...draft,
    brief: clean(draft.brief).slice(0, 1200),
    motion: draft.motion ? clean(draft.motion).slice(0, 600) : null,
    details: Object.fromEntries(Object.entries(draft.details).map(([k, v]) => [k, clean(v)])) as PromptDetails,
  };
  const outHits = ruleCheck(`${draft.brief}\n${draft.motion ?? ""}\n${Object.values(draft.details).join("\n")}`);
  if (outHits.length) throw new AssistantRefused(422, `The draft hit a banned-use rule, so it wasn't returned (${outHits.join("; ")}). Try different inputs.`);
  return draft;
}

async function geminiDraft(input: AssistantInput, useLabel: string, regenerate: boolean): Promise<AssistantDraft> {
  const ask = [
    `Format: ${input.format === "video" ? "video ad (write a still prompt for its first frame, and a motion prompt)" : "image ad"}`,
    `Aspect: ${input.aspect}. ${ASPECT_GUIDANCE[input.aspect]}`,
    `Idea: ${input.idea || "(none: a simple product ad)"}`,
    `Product: ${input.product || "(unspecified: a generic product)"}`,
    `Setting: ${input.setting || "(choose one that suits the idea)"}`,
    `Mood: ${input.mood}`,
  ].join("\n");
  const res = await generateContent(
    geminiModels.filter(),
    {
      systemInstruction: { parts: [{ text: INSTRUCTION(useLabel) }] },
      contents: [{ role: "user", parts: [{ text: ask }] }],
      generationConfig: { temperature: regenerate ? 1.0 : 0.6, responseMimeType: "application/json", responseJsonSchema: SCHEMA },
    },
    25_000,
  );
  if (res.promptFeedback?.blockReason) throw new AssistantRefused(422, `The assistant won't write this (Gemini safety: ${res.promptFeedback.blockReason}).`);
  const text = res.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const o = JSON.parse(text) as Record<string, unknown>;
  if (o.refused === true) throw new AssistantRefused(422, `The assistant won't write this: ${clip(o.refusalReason, 300) || "outside this licence's allowed use"}`);
  const details: PromptDetails = {
    subject: clip(o.subject, 400),
    action: clip(o.action, 400),
    setting: clip(o.setting, 400),
    wardrobe: clip(o.wardrobe, 200),
    composition: clip(o.composition, 400),
    style: clip(o.style, 200),
  };
  if (Object.values(details).some((v) => !v)) throw new Error("Gemini returned an incomplete draft");
  const brief = clip(o.brief, 1200) || briefFrom(details);
  const motion = input.format === "video" ? clip(o.motion, 600) || null : null;
  return { brief, details, motion, aspect: input.aspect, format: input.format, source: "gemini", note: `Written by ${geminiModels.filter()} on Vertex AI.` };
}
