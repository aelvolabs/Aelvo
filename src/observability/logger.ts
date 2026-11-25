import pino, { type Logger } from "pino";
import { redactText } from "./redact.js";

export type { Logger };

/**
 * Structured logs go to stderr; stdout belongs to machine-readable CLI output.
 * Credential-shaped keys are redacted by path and by value.
 */
export function createLogger(level: string, destination: NodeJS.WritableStream = process.stderr): Logger {
  return pino(
    {
      level,
      base: { service: "aelvo" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          "apiKey",
          "api_key",
          "token",
          "authorization",
          "password",
          "secret",
          "*.apiKey",
          "*.token",
          "*.authorization",
          "*.password",
          "*.secret",
          "req.headers.authorization",
        ],
        censor: "[REDACTED]",
      },
      formatters: {
        log(object) {
          return Object.fromEntries(
            Object.entries(object).map(([key, value]) => [
              key,
              typeof value === "string" ? redactText(value) : value,
            ]),
          );
        },
      },
    },
    destination,
  );
}

export const silentLogger: Logger = pino({ level: "silent" });
