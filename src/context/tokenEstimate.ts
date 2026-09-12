/**
 * Deterministic, dependency-free token estimator for Unit 4's context
 * compiler (Phase 5 MVP scope).
 *
 * This is explicitly NOT a real tokenizer: it never calls an LLM, a
 * tokenizer library, or any external service (out of scope per the Unit 4
 * brief — "just a cheap deterministic estimate"). It uses the common
 * approximation of ~4 characters per token for English-ish text/JSON,
 * rounding UP (`Math.ceil`) so any non-empty string estimates to at least 1
 * token rather than silently rounding down to 0 for short strings.
 *
 * Because it is pure and deterministic (same input string -> same output
 * every time, no I/O), it is trivially safe to call synchronously and
 * repeatedly during compilation and in unit tests.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
