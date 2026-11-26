import { isAelvoError } from "../../shared/errors/index.js";
import type { CredentialService } from "./service.js";
import { validateCredentialSecret } from "./validation.js";

export const GOOGLE_API_KEY_CREDENTIAL = "google.api-key";

export type ProviderCredentialSource = "environment" | "store" | "injected" | "none";

export interface ResolvedGoogleCredential {
  apiKey?: string;
  source: ProviderCredentialSource;
  /** Safe, secret-free explanation when a configured credential could not be used. */
  detail?: string;
}

/**
 * Resolve the Google API key without exposing it to logs or model context.
 *
 * An explicit environment/config key wins over stored state so deployment
 * overrides remain predictable. Stored credentials are the fallback and are
 * fully validated before use.
 */
export async function resolveGoogleApiKey(
  credentials: CredentialService,
  environmentKey: string | undefined,
): Promise<ResolvedGoogleCredential> {
  if (environmentKey !== undefined) {
    const validation = validateCredentialSecret(environmentKey, GOOGLE_API_KEY_CREDENTIAL);
    if (!validation.valid) {
      return { source: "none", detail: `Environment API key is invalid: ${validation.reason}` };
    }
    return { apiKey: environmentKey, source: "environment" };
  }

  try {
    return { apiKey: await credentials.resolve(GOOGLE_API_KEY_CREDENTIAL), source: "store" };
  } catch (error) {
    // A missing credential is a normal unconfigured state. Other failures are
    // reported, but never prevent the CLI from inspecting or repairing them.
    if (isAelvoError(error) && error.code === "CREDENTIAL_NOT_FOUND") return { source: "none" };
    return {
      source: "none",
      detail: isAelvoError(error) ? `${error.code}: ${error.message}` : "Credential store lookup failed",
    };
  }
}
