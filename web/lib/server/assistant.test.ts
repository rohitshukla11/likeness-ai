/**
 * The creative assistant's safety: banned inputs never reach the model, the model is told the
 * licence's one allowed use, a model refusal is passed on, banned drafts are never returned, the
 * creator's name never appears, and the template stands in when Gemini fails. Gemini is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
vi.mock("./gemini", () => ({
  generateContent: (...a: unknown[]) => generateContent(...a),
  geminiModels: { filter: () => "gemini-test", image: () => "img-test" },
  vertexConfigured: () => true,
}));

const { cleanInput, templateDraft, writePrompt, AssistantRefused } = await import("./assistant");

const reply = (o: Record<string, unknown>) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] });
const good = {
  refused: false,
  refusalReason: "",
  subject: "Medium close-up of the person, full head and face visible with headroom.",
  action: "Holding a ceramic coffee cup at chest height, label facing camera.",
  setting: "Sunlit café, soft window light from the left.",
  wardrobe: "Neutral knit sweater.",
  composition: "Clean space on the right for a headline.",
  style: "Photorealistic commercial photography.",
  brief: "Medium close-up of the person holding a ceramic coffee cup in a sunlit café, photorealistic.",
  motion: "Slow push-in; the person lifts the cup and smiles.",
};
const input = cleanInput({ idea: "spring coffee promo", product: "oat latte", setting: "sunlit café", mood: "warm", aspect: "16:9", format: "video" });

beforeEach(() => {
  generateContent.mockReset();
});

describe("creative assistant", () => {
  it("writes within the licence's allowed use and returns an editable draft with a motion prompt", async () => {
    generateContent.mockResolvedValue(reply(good));
    const d = await writePrompt({ input, use: "advertising", creatorName: "Rohit Shukla" });
    const body = generateContent.mock.calls[0][1] as { systemInstruction: { parts: { text: string }[] } };
    const sys = body.systemInstruction.parts[0].text;
    expect(sys).toMatch(/allows exactly one use: Advertising/);
    expect(sys).toMatch(/political/);
    expect(sys).toMatch(/Never use or invent a name/);
    expect(sys).not.toMatch(/Rohit/);
    expect(d.source).toBe("gemini");
    expect(d.brief).toMatch(/coffee cup/);
    expect(d.motion).toMatch(/push-in/);
    expect(d.aspect).toBe("16:9");
  });

  it("refuses banned inputs before calling the model", async () => {
    await expect(writePrompt({ input: cleanInput({ idea: "vote for our candidate rally" }), use: "advertising" })).rejects.toBeInstanceOf(AssistantRefused);
    await expect(writePrompt({ input: cleanInput({ idea: "sexy lingerie shoot" }), use: "advertising" })).rejects.toThrow(/banned use/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("passes on the model's refusal (outside the allowed use)", async () => {
    generateContent.mockResolvedValue(reply({ ...good, refused: true, refusalReason: "a news report is editorial, not advertising" }));
    await expect(writePrompt({ input, use: "advertising" })).rejects.toThrow(/editorial, not advertising/);
  });

  it("never returns a draft that hits a banned-use rule", async () => {
    generateContent.mockResolvedValue(reply({ ...good, brief: "The person posing as a famous senator at a campaign rally." }));
    await expect(writePrompt({ input, use: "advertising" })).rejects.toThrow(/banned-use rule/);
  });

  it("replaces the creator's name if the model writes it anyway", async () => {
    generateContent.mockResolvedValue(reply({ ...good, brief: "Rohit Shukla holding a cup; Rohit smiles." }));
    const d = await writePrompt({ input, use: "advertising", creatorName: "Rohit Shukla" });
    expect(d.brief).not.toMatch(/Rohit|Shukla/);
    expect(d.brief).toMatch(/the person/);
  });

  it("falls back to the template when Gemini fails, still with framing and no claims", async () => {
    generateContent.mockImplementation(() => {
      throw new Error("HTTP 503");
    });
    const d = await writePrompt({ input, use: "advertising" });
    expect(d.source).toBe("template");
    expect(d.details.subject).toMatch(/full head and face visible with headroom/);
    expect(d.motion).toMatch(/full face stays in frame/);
    expect(d.note).toMatch(/Gemini was unavailable/);
  });

  it("cleans inputs: a video is never 1:1, unknown moods become warm, strings are capped", () => {
    const c = cleanInput({ format: "video", aspect: "1:1", mood: "sultry", idea: "x".repeat(500) });
    expect(c.aspect).toBe("16:9");
    expect(c.mood).toBe("warm");
    expect(c.idea.length).toBe(120);
    expect(templateDraft(cleanInput({}), "Advertising").motion).toBeNull();
  });
});
