import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { AelvoError } from "../../../shared/errors/index.js";
import type { ToolDescriptor } from "../../../tools/registry/types.js";
import type { ProviderModelMetadata, ProviderStructuredOutputRequest } from "../types.js";

const VALID_FUNCTION_NAME = /^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/;

const UNSUPPORTED_SCHEMA_KEYWORDS = [
  "patternProperties",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "not",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

const METADATA_ONLY_KEYWORDS = new Set(["$schema", "$comment"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Convert either a Zod v4 schema or a raw JSON Schema record into a clean
 * JSON Schema object without mutating caller objects.
 */
export function resolveJsonSchema(input: z.ZodType | Record<string, unknown>): Record<string, unknown> {
  if (input instanceof z.ZodType || (isPlainObject(input) && "_zod" in input)) {
    return z.toJSONSchema(input as z.ZodType, { io: "input" }) as Record<string, unknown>;
  }
  return structuredClone(input);
}

/**
 * Normalize a JSON Schema into the subset supported by Google Gemini tool
 * declarations and structured outputs, failing loudly on constructs Gemini
 * does not support instead of silently dropping constraints.
 */
export function sanitizeGeminiJsonSchema(
  schema: Record<string, unknown>,
  contextLabel: string,
  seen = new WeakSet<object>(),
): Record<string, unknown> {
  if (seen.has(schema)) {
    throw new AelvoError("TOOL_INPUT_INVALID", `${contextLabel} contains an unguarded cyclic schema object`, {
      details: { contextLabel },
    });
  }
  seen.add(schema);

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (METADATA_ONLY_KEYWORDS.has(key)) {
      continue;
    }
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key)) {
      throw new AelvoError(
        "TOOL_INPUT_INVALID",
        `${contextLabel} uses unsupported JSON Schema keyword "${key}" for Gemini`,
        { details: { contextLabel, keyword: key } },
      );
    }

    if (key === "const") {
      output.enum = [value];
      continue;
    }

    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((item): item is string => typeof item === "string");
      if (types.length === 0) {
        throw new AelvoError("TOOL_INPUT_INVALID", `${contextLabel} has an empty type array`);
      }
      if (types.length === 1) {
        output.type = types[0];
      } else {
        output.anyOf = types.map((entry) => ({ type: entry }));
      }
      continue;
    }

    if (key === "properties" && isPlainObject(value)) {
      const nextProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        nextProps[propName] = isPlainObject(propSchema)
          ? sanitizeGeminiJsonSchema(propSchema, `${contextLabel}.${propName}`, seen)
          : propSchema;
      }
      output.properties = nextProps;
      continue;
    }

    if ((key === "$defs" || key === "definitions") && isPlainObject(value)) {
      const nextDefs: Record<string, unknown> = {};
      for (const [defName, defSchema] of Object.entries(value)) {
        nextDefs[defName] = isPlainObject(defSchema)
          ? sanitizeGeminiJsonSchema(defSchema, `${contextLabel}.$defs.${defName}`, seen)
          : defSchema;
      }
      output[key] = nextDefs;
      continue;
    }

    if (key === "items") {
      if (Array.isArray(value)) {
        output.prefixItems = value.map((item, idx) =>
          isPlainObject(item) ? sanitizeGeminiJsonSchema(item, `${contextLabel}[${idx}]`, seen) : item,
        );
      } else if (isPlainObject(value)) {
        output.items = sanitizeGeminiJsonSchema(value, `${contextLabel}[]`, seen);
      } else {
        output.items = value;
      }
      continue;
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf" || key === "prefixItems") && Array.isArray(value)) {
      output[key] = value.map((item, idx) =>
        isPlainObject(item) ? sanitizeGeminiJsonSchema(item, `${contextLabel}.${key}[${idx}]`, seen) : item,
      );
      continue;
    }

    if (key === "additionalProperties" && isPlainObject(value)) {
      output.additionalProperties = sanitizeGeminiJsonSchema(value, `${contextLabel}.additionalProperties`, seen);
      continue;
    }

    output[key] = value;
  }

  seen.delete(schema);
  return output;
}

export function toGeminiFunctionDeclarations(
  tools: ToolDescriptor[],
  metadata: ProviderModelMetadata,
): FunctionDeclaration[] {
  if (tools.length === 0) return [];
  if (metadata.details.functionCalling === false) {
    throw new AelvoError(
      "PROVIDER_MODEL_UNSUPPORTED",
      `Model ${metadata.model} does not support native function calling`,
      { details: { model: metadata.model } },
    );
  }

  return tools.map((tool) => {
    if (!VALID_FUNCTION_NAME.test(tool.name)) {
      throw new AelvoError(
        "TOOL_INPUT_INVALID",
        `Tool name "${tool.name}" violates Gemini function naming rules`,
        { details: { tool: tool.name } },
      );
    }
    const sanitized = sanitizeGeminiJsonSchema(tool.parameters, `tool:${tool.name}`);
    const parametersJsonSchema =
      sanitized.type === undefined && sanitized.anyOf === undefined && sanitized.oneOf === undefined
        ? { type: "object", ...sanitized }
        : sanitized;

    return {
      name: tool.name,
      description: tool.description,
      parametersJsonSchema,
    };
  });
}

function stripJsonCodeFence(text: string): string | null {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? null;
}

function validateBasicJsonSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$",
): string | null {
  const expectedType = schema.type;
  if (typeof expectedType === "string") {
    switch (expectedType) {
      case "object": {
        if (!isPlainObject(value)) return `${path}: expected object`;
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const req of required) {
          if (typeof req === "string" && !(req in value)) {
            return `${path}.${req}: missing required property`;
          }
        }
        const props = isPlainObject(schema.properties) ? schema.properties : undefined;
        if (props !== undefined) {
          for (const [k, propSchema] of Object.entries(props)) {
            if (k in value && isPlainObject(propSchema)) {
              const issue = validateBasicJsonSchemaValue(value[k], propSchema, `${path}.${k}`);
              if (issue !== null) return issue;
            }
          }
        }
        break;
      }
      case "array": {
        if (!Array.isArray(value)) return `${path}: expected array`;
        if (isPlainObject(schema.items)) {
          for (let i = 0; i < value.length; i += 1) {
            const issue = validateBasicJsonSchemaValue(value[i], schema.items, `${path}[${i}]`);
            if (issue !== null) return issue;
          }
        }
        break;
      }
      case "string":
        if (typeof value !== "string") return `${path}: expected string`;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return `${path}: expected number`;
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) return `${path}: expected integer`;
        break;
      case "boolean":
        if (typeof value !== "boolean") return `${path}: expected boolean`;
        break;
      case "null":
        if (value !== null) return `${path}: expected null`;
        break;
      default:
        break;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path}: value not in allowed enum`;
  }
  return null;
}

export function parseAndValidateStructuredOutput<T = unknown>(
  rawText: string,
  config: ProviderStructuredOutputRequest<T>,
): T {
  const schemaLabel = config.schemaName ?? "structured_output";
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new AelvoError("PROVIDER_RESPONSE_INVALID", `Provider returned empty output for ${schemaLabel}`, {
      details: { schema: schemaLabel },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (directError) {
    const unfenced = stripJsonCodeFence(trimmed);
    if (unfenced === null) {
      throw new AelvoError("PROVIDER_RESPONSE_INVALID", `Provider returned invalid JSON for ${schemaLabel}`, {
        cause: directError,
        details: { schema: schemaLabel },
      });
    }
    try {
      parsed = JSON.parse(unfenced);
    } catch (fenceError) {
      throw new AelvoError("PROVIDER_RESPONSE_INVALID", `Provider returned invalid JSON for ${schemaLabel}`, {
        cause: fenceError,
        details: { schema: schemaLabel },
      });
    }
  }

  if (config.validate !== undefined) {
    const verdict = config.validate(parsed);
    if (!verdict.ok) {
      throw new AelvoError(
        "PROVIDER_RESPONSE_INVALID",
        `Structured output validation failed for ${schemaLabel}: ${verdict.error}`,
        { details: { schema: schemaLabel, validationError: verdict.error } },
      );
    }
    return verdict.data;
  }

  if (config.jsonSchema !== undefined) {
    const issue = validateBasicJsonSchemaValue(parsed, config.jsonSchema);
    if (issue !== null) {
      throw new AelvoError(
        "PROVIDER_RESPONSE_INVALID",
        `Structured output schema mismatch for ${schemaLabel}: ${issue}`,
        { details: { schema: schemaLabel, validationError: issue } },
      );
    }
  }

  return parsed as T;
}
