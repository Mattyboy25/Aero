// The models a user can pick. Opus can use the server-side safety fallback; Sonnet and Haiku
// can't (Haiku has none), so a refusal from them is reported as an error instead.
export const MODELS = {
  opus: { id: "claude-opus-5-5", label: "Opus 5.5", fallback: true },
  sonnet: { id: "claude-sonnet-5-5", label: "Sonnet 5.5", fallback: false },
  haiku: { id: "claude-haiku-5-5", label: "Haiku 5.5", fallback: false },
};
export const DEFAULT_MODEL = "opus";

export const pickModel = (key) => (Object.hasOwn(MODELS, key) ? key : DEFAULT_MODEL);

// Starts a streaming request on the chosen model.
export function streamMessage(client, key, params, options) {
  const model = MODELS[pickModel(key)];
  const body = { model: model.id, ...params };
  if (model.fallback) {
    // If a safety classifier declines, retry on Anthropic's recommended fallback model.
    return client.beta.messages.stream(
      { ...body, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
      options
    );
  }
  return client.messages.stream(body, options);
}
