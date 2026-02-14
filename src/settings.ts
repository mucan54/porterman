import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isValidPort } from "./utils.js";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SettingsConfig {
  tunnels: Record<string, TunnelSettings>;
}

export interface TunnelSettings {
  envFile: string;
  variables: Record<string, string | number>;
}

export interface BackupEntry {
  envFile: string;
  variable: string;
  originalValue: string | null;
  envFileCreated: boolean;
}

export interface BackupManifest {
  version: number;
  createdAt: string;
  createdEnvFiles: string[];
  entries: BackupEntry[];
}

// ── Env file helpers ───────────────────────────────────────────────────

export function parseEnvFile(
  content: string
): Map<string, { value: string; line: number }> {
  const result = new Map<string, { value: string; line: number }>();
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip blank lines and comments
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

    // Handle quoted values
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result.set(key, { value, line: i });
  }

  return result;
}

export function setEnvVariable(
  content: string,
  key: string,
  value: string
): string {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const lineKey = line.slice(0, eqIndex).trim();
    if (lineKey === key) {
      // Replace in-place, preserving any leading whitespace from the original line
      const leadingWhitespace = lines[i].match(/^(\s*)/)?.[1] ?? "";
      lines[i] = `${leadingWhitespace}${key}=${value}`;
      return lines.join("\n");
    }
  }

  // Key doesn't exist — prepend to top
  const newLine = `${key}=${value}`;
  if (content.length === 0) {
    return newLine + "\n";
  }
  return newLine + "\n" + content;
}

export function removeEnvVariable(content: string, key: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let prevWasBlank = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const eqIndex = trimmed.indexOf("=");

    if (eqIndex !== -1) {
      const lineKey = trimmed.slice(0, eqIndex).trim();
      if (lineKey === key) {
        // Skip this line — mark as blank for dedup purposes
        prevWasBlank = true;
        continue;
      }
    }

    // Collapse consecutive blank lines
    const isBlank = trimmed === "";
    if (isBlank && prevWasBlank) continue;
    prevWasBlank = isBlank;

    filtered.push(lines[i]);
  }

  // Remove leading blank lines
  while (filtered.length > 0 && filtered[0].trim() === "") {
    filtered.shift();
  }

  return filtered.join("\n");
}

// ── Settings functions ─────────────────────────────────────────────────

export function loadSettings(name: string): SettingsConfig {
  const filePath = resolve(`${name}.porterman.json`);

  if (!existsSync(filePath)) {
    throw new Error(`${name}.porterman.json not found in current directory`);
  }

  let raw: string;
  try {
    raw = require("node:fs").readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read ${name}.porterman.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let config: SettingsConfig;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error(`${name}.porterman.json contains invalid JSON`);
  }

  // Validate structure
  if (!config.tunnels || typeof config.tunnels !== "object") {
    throw new Error(
      `${name}.porterman.json: missing or invalid "tunnels" object`
    );
  }

  for (const [portStr, tunnel] of Object.entries(config.tunnels)) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || !isValidPort(port)) {
      throw new Error(
        `${name}.porterman.json: port '${portStr}' is invalid (must be 1-65535)`
      );
    }

    if (!tunnel.envFile || typeof tunnel.envFile !== "string") {
      throw new Error(
        `${name}.porterman.json: tunnel ${portStr} has missing or invalid "envFile"`
      );
    }

    if (!tunnel.variables || typeof tunnel.variables !== "object") {
      throw new Error(
        `${name}.porterman.json: tunnel ${portStr} has missing or invalid "variables"`
      );
    }
  }

  return config;
}

export function createBackup(config: SettingsConfig): BackupManifest {
  const entries: BackupEntry[] = [];
  const createdEnvFiles: string[] = [];
  const checkedFiles = new Set<string>();

  for (const [, tunnel] of Object.entries(config.tunnels)) {
    const envFilePath = resolve(tunnel.envFile);
    const fileExists = existsSync(envFilePath);
    const isNewFile = !fileExists && !checkedFiles.has(envFilePath);

    if (isNewFile) {
      createdEnvFiles.push(tunnel.envFile);
    }

    let parsed = new Map<string, { value: string; line: number }>();
    if (fileExists) {
      try {
        const content = require("node:fs").readFileSync(envFilePath, "utf-8");
        parsed = parseEnvFile(content);
      } catch {
        // If we can't read the file, treat all variables as new
      }
    }

    for (const variable of Object.keys(tunnel.variables)) {
      const existing = parsed.get(variable);
      entries.push({
        envFile: tunnel.envFile,
        variable,
        originalValue: existing ? existing.value : null,
        envFileCreated: isNewFile,
      });
    }

    checkedFiles.add(envFilePath);
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    createdEnvFiles,
    entries,
  };
}

export function writeBackupFile(name: string, manifest: BackupManifest): void {
  const filePath = resolve(`.${name}.porterman.backup.env`);
  require("node:fs").writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

export function readBackupFile(name: string): BackupManifest | null {
  const filePath = resolve(`.${name}.porterman.backup.env`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = require("node:fs").readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // Backup file is corrupted
    const corruptedPath = filePath + ".corrupted";
    try {
      require("node:fs").renameSync(filePath, corruptedPath);
      logger.warn(
        `Backup file was corrupted, renamed to ${corruptedPath}`
      );
    } catch {
      // If rename also fails, just log
      logger.warn("Backup file was corrupted and could not be recovered");
    }
    return null;
  }
}

export async function applySettings(
  config: SettingsConfig,
  tunnelUrls: Map<number, string>
): Promise<void> {
  // Group all variables by envFile to batch writes
  const fileUpdates = new Map<
    string,
    Array<{ key: string; value: string }>
  >();

  for (const [portStr, tunnel] of Object.entries(config.tunnels)) {
    const port = parseInt(portStr, 10);
    const url = tunnelUrls.get(port);

    if (!url) {
      logger.warn(
        `Tunnel for port ${port} has no URL — skipping variables for ${tunnel.envFile}`
      );
      continue;
    }

    const envFilePath = tunnel.envFile;
    if (!fileUpdates.has(envFilePath)) {
      fileUpdates.set(envFilePath, []);
    }

    for (const [key, rawValue] of Object.entries(tunnel.variables)) {
      let value: string;
      if (rawValue === "$tunnelUrl") {
        value = url;
      } else {
        value = String(rawValue);
      }
      fileUpdates.get(envFilePath)!.push({ key, value });
    }
  }

  // Apply all updates per file
  for (const [envFile, updates] of fileUpdates) {
    const envFilePath = resolve(envFile);
    let content = "";

    if (existsSync(envFilePath)) {
      try {
        content = await readFile(envFilePath, "utf-8");
      } catch (err) {
        logger.error(
          `Failed to read ${envFile}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }

    for (const { key, value } of updates) {
      content = setEnvVariable(content, key, value);
    }

    try {
      await writeFile(envFilePath, content);
    } catch (err) {
      logger.error(
        `Failed to write ${envFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export async function restoreFromBackup(
  name: string,
  manifest: BackupManifest
): Promise<void> {
  const backupPath = resolve(`.${name}.porterman.backup.env`);

  // Determine which env files were created by porterman (should be deleted entirely)
  const createdFilesSet = new Set(
    manifest.createdEnvFiles.map((f) => resolve(f))
  );

  // Group entries by envFile for batched operations
  const fileEntries = new Map<string, BackupEntry[]>();
  for (const entry of manifest.entries) {
    const key = resolve(entry.envFile);
    if (!fileEntries.has(key)) {
      fileEntries.set(key, []);
    }
    fileEntries.get(key)!.push(entry);
  }

  for (const [envFilePath, entries] of fileEntries) {
    // If the entire file was created by porterman, delete it
    if (createdFilesSet.has(envFilePath)) {
      try {
        if (existsSync(envFilePath)) {
          await unlink(envFilePath);
        }
      } catch {}
      continue;
    }

    if (!existsSync(envFilePath)) continue;

    let content: string;
    try {
      content = await readFile(envFilePath, "utf-8");
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.originalValue === null) {
        // Variable was added by porterman — remove it
        content = removeEnvVariable(content, entry.variable);
      } else {
        // Restore original value
        content = setEnvVariable(content, entry.variable, entry.originalValue);
      }
    }

    try {
      await writeFile(envFilePath, content);
    } catch {}
  }

  // Delete backup file
  try {
    if (existsSync(backupPath)) {
      await unlink(backupPath);
    }
  } catch {}
}

export function getBackupFilePath(name: string): string {
  return resolve(`.${name}.porterman.backup.env`);
}

export function getSettingsFilePath(name: string): string {
  return resolve(`${name}.porterman.json`);
}
