export type RenderInput = {
  prompt: string;
  /** Decrypted reference frames (JPEG). The renderer must not keep them. */
  references: Uint8Array[];
  licenceId: string;
  renderIndex: number;
  aspectRatio?: "1:1" | "16:9" | "9:16";
};

export type RenderOutput = {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
  provider: "gemini";
  model: string;
  test: false;
  /** Provider-reported usage (Gemini usageMetadata), for cost accounting. */
  usage?: Record<string, unknown>;
};
