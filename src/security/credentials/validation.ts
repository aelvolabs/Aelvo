import { AelvoError } from "../../shared/errors/index.js";

export type CredentialType =
  | "api_key"
  | "oauth_token"
  | "refresh_token"
  | "session_token"
  | "service_account"
  | "custom_header"
  | "bearer_token";

export interface CredentialValidation {
  valid: boolean;
  reason: string;
}

const PLACEHOLDER = /(your[-_ ]?api[-_ ]?key|placeholder|dummy[-_ ]?key|test[-_ ]?key|change[-_ ]?me|example[-_ ]?key)/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const GOOGLE_LEGACY_KEY = /^AIza[0-9A-Za-z_-]{35}$/;
// AI Studio now issues 53-character authentication keys ("AQ." + 50
// base64url characters). Keep accepting legacy AIza traffic keys as well.
const GOOGLE_AUTH_KEY = /^AQ\.[0-9A-Za-z_-]{50}$/;

/**
 * Credential names are stable identifiers, not free-form labels. Restricting
 * them prevents path traversal in the file-backed backend and shell injection
 * in the platform helpers.
 */
export function assertCredentialName(name: string): void {
  if (!/^[a-z0-9._-]{1,64}$/i.test(name)) {
    throw new AelvoError("CREDENTIAL_INVALID", "Invalid credential name", {
      details: { name },
    });
  }
}

function providerOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "google" || lower.startsWith("google.") || lower.startsWith("gemini.")) return "google";
  return lower.split(".")[0] ?? lower;
}

/**
 * Port of the useful format checks from archive/auth/auth/api_key.py.
 * Validation is deliberately provider-aware but does not attempt to prove a
 * key is live; only the provider can do that.
 */
export function validateCredentialSecret(secret: string, credentialName = ""): CredentialValidation {
  if (secret.length === 0 || secret.trim().length === 0) {
    return { valid: false, reason: "Credential value must not be empty" };
  }
  if (secret.length < 10) {
    return { valid: false, reason: "Credential value is too short (minimum 10 characters)" };
  }
  if (secret.length > 8_192) {
    return { valid: false, reason: "Credential value is unreasonably long" };
  }
  if (/\s/.test(secret)) {
    return { valid: false, reason: "Credential value must not contain whitespace" };
  }
  if (CONTROL.test(secret)) {
    return { valid: false, reason: "Credential value contains control characters" };
  }
  if (PLACEHOLDER.test(secret)) {
    return { valid: false, reason: "Credential value appears to be a placeholder" };
  }
  if (
    providerOf(credentialName) === "google" &&
    !GOOGLE_LEGACY_KEY.test(secret) &&
    !GOOGLE_AUTH_KEY.test(secret)
  ) {
    return {
      valid: false,
      reason: "Google API keys must match the AIza... or AQ.... format",
    };
  }
  return { valid: true, reason: "Credential format is valid" };
}

/** Metadata-safe hint: never include the first characters of the secret. */
export function credentialHint(secret: string): string {
  return secret.length <= 8 ? "****" : `****${secret.slice(-4)}`;
}
