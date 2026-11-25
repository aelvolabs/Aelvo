import { z } from "zod";
import { AelvoError } from "../../shared/errors/index.js";
import type { AnyTool, ToolDescriptor } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new AelvoError("CONFIG_INVALID", `Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new AelvoError("TOOL_NOT_FOUND", `Unknown tool: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  list(): AnyTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Model-facing descriptors derived from the same Zod schema used to parse. */
  descriptors(): ToolDescriptor[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>,
    }));
  }
}
