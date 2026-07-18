import type { RateLimitState } from "./github-port.js";

export interface RateStateReader {
  getState(): RateLimitState | null;
}
