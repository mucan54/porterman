import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger.js";

const DEFAULT_ENV_FILE = ".env.porterman";
const MARKER_START = "# [porterman:start]";
const MARKER_END = "# [porterman:end]";

export interface EnvMapping {
  port: number;
  envVar: string;
}

/**
 * Parse port arguments that may include env variable names.
 * Supports formats:
 *   "3000"              -> { port: 3000, envVar: undefined }
 *   "3000:FRONTEND_URL" -> { port: 3000, envVar: "FRONTEND_URL" }
 */
export function parsePortArg(arg: string): { port: number; envVar?: string } {
  const parts = arg.split(":");
  const portStr = parts[0];
  const envVar = parts[1] || undefined;

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portStr}`);
  }

  if (envVar !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
      throw new Error(
        `Invalid env variable name: "${envVar}". Use letters, digits, and underscores (e.g., FRONTEND_URL).`
      );
    }
  }

  return { port, envVar };
}

/**
 * Build the porterman-managed block content.
 */
function buildManagedBlock(mappings: Map<string, string>): string {
  const lines = [MARKER_START];
  for (const [envVar, url] of mappings) {
    lines.push(`${envVar}=${url}`);
  }
  lines.push(MARKER_END);
  return lines.join("\n");
}

/**
 * Write URL-to-env-variable mappings into a .env file.
 *
 * If the file already exists:
 *   - If it contains a [porterman:start]...[porterman:end] block, that block is replaced in place.
 *   - Otherwise, the managed block is prepended to the top of the file so that
 *     later lines can reference the variables (e.g. APP_URL=${FRONTEND_URL}).
 *
 * If the file does not exist, it is created with the managed block.
 *
 * Existing content outside the managed block is never modified.
 */
export async function writeEnvFile(
  mappings: Map<string, string>,
  filePath?: string
): Promise<string> {
  const target = resolve(filePath ?? DEFAULT_ENV_FILE);
  const block = buildManagedBlock(mappings);

  if (existsSync(target)) {
    const existing = await readFile(target, "utf-8");
    const updated = replaceManagedBlock(existing, block);
    await writeFile(target, updated);
  } else {
    await writeFile(target, block + "\n");
  }

  return target;
}

/**
 * Replace (in place) or prepend the managed block within file content.
 */
function replaceManagedBlock(content: string, block: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing block in place
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + MARKER_END.length);
    return before + block + after;
  }

  // Prepend so that later lines can reference the variables
  const separator = content.length > 0 && !content.startsWith("\n") ? "\n\n" : "";
  return block + separator + content;
}

/**
 * Remove porterman-managed lines from a .env file on shutdown.
 *
 * If the file is the default `.env.porterman`, it is deleted entirely.
 * If it is a user-provided file (like `.env`), only the managed block is removed.
 */
export async function cleanEnvFile(filePath?: string): Promise<void> {
  const isDefault = !filePath;
  const target = resolve(filePath ?? DEFAULT_ENV_FILE);

  if (!existsSync(target)) return;

  if (isDefault) {
    // Default porterman file: delete entirely
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(target);
    } catch {}
    return;
  }

  // User-provided file: remove only the managed block
  try {
    const content = await readFile(target, "utf-8");
    const cleaned = removeManagedBlock(content);
    await writeFile(target, cleaned);
  } catch {}
}

/**
 * Remove the managed block from file content.
 */
function removeManagedBlock(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1) return content;

  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);

  // Clean up extra blank lines left behind
  const result = (before + after).replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");

  return result;
}

/**
 * Format env mappings as shell export statements for eval mode.
 */
export function formatExports(mappings: Map<string, string>): string {
  const lines: string[] = [];
  for (const [envVar, url] of mappings) {
    lines.push(`export ${envVar}=${url}`);
  }
  return lines.join("\n");
}

// Exported for testing
export { MARKER_START, MARKER_END };
