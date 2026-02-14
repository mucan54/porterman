import { readFile, writeFile, unlink } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { isValidPort } from "./utils.js";
import { logger } from "./logger.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface SettingsConfig {
  tunnels: Record<string, TunnelSettings>;
  cleanup?: boolean;
  verbose?: boolean;
}

export interface TunnelSettings {
  envFiles: FileTarget[];
}

export interface FileTarget {
  file: string;
  filePath?: string;
  type?: "env" | "json";
  variables: Record<string, string | number>;
}

export interface BackupEntry {
  file: string;
  fileType: "env" | "json";
  variable: string;
  originalValue: string | number | null;
  fileCreated: boolean;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  createdFiles: string[];
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

    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    let value = line.slice(eqIndex + 1).trim();

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
      const leadingWhitespace = lines[i].match(/^(\s*)/)?.[1] ?? "";
      lines[i] = `${leadingWhitespace}${key}=${value}`;
      return lines.join("\n");
    }
  }

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
        prevWasBlank = true;
        continue;
      }
    }

    const isBlank = trimmed === "";
    if (isBlank && prevWasBlank) continue;
    prevWasBlank = isBlank;

    filtered.push(lines[i]);
  }

  while (filtered.length > 0 && filtered[0].trim() === "") {
    filtered.shift();
  }

  return filtered.join("\n");
}

// ── JSON helpers ───────────────────────────────────────────────────────

export function getJsonValue(data: Record<string, unknown>, dotPath: string): unknown {
  const keys = dotPath.split(".");
  let current: unknown = data;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setJsonValue(data: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split(".");
  let current: Record<string, unknown> = data;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (
      current[key] === null ||
      current[key] === undefined ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

export function deleteJsonValue(data: Record<string, unknown>, dotPath: string): void {
  const keys = dotPath.split(".");
  let current: unknown = data;
  for (let i = 0; i < keys.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== "object") {
      return;
    }
    current = (current as Record<string, unknown>)[keys[i]];
  }
  if (current !== null && current !== undefined && typeof current === "object") {
    delete (current as Record<string, unknown>)[keys[keys.length - 1]];
  }
}

// ── File resolution helpers ────────────────────────────────────────────

export function resolveFileType(target: FileTarget): "env" | "json" {
  if (target.type) return target.type;
  if (target.file.endsWith(".json")) return "json";
  return "env";
}

export function resolveTargetPath(target: FileTarget): string {
  if (target.filePath && target.filePath !== "") {
    return resolve(target.filePath, target.file);
  }
  return resolve(target.file);
}

// ── Settings functions ─────────────────────────────────────────────────

export function loadSettings(name: string): SettingsConfig {
  const filePath = resolve(`${name}.porterman.json`);

  if (!existsSync(filePath)) {
    throw new Error(`${name}.porterman.json not found in current directory`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
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

  if (!config.tunnels || typeof config.tunnels !== "object") {
    throw new Error(
      `${name}.porterman.json: missing or invalid "tunnels" object`
    );
  }

  if (config.cleanup !== undefined && typeof config.cleanup !== "boolean") {
    throw new Error(`${name}.porterman.json: "cleanup" must be a boolean`);
  }

  if (config.verbose !== undefined && typeof config.verbose !== "boolean") {
    throw new Error(`${name}.porterman.json: "verbose" must be a boolean`);
  }

  for (const [portStr, tunnel] of Object.entries(config.tunnels)) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || !isValidPort(port)) {
      throw new Error(
        `${name}.porterman.json: port '${portStr}' is invalid (must be 1-65535)`
      );
    }

    if (!Array.isArray(tunnel.envFiles)) {
      throw new Error(
        `${name}.porterman.json: tunnel ${portStr} has missing or invalid "envFiles" array`
      );
    }

    for (let i = 0; i < tunnel.envFiles.length; i++) {
      const target = tunnel.envFiles[i];

      if (!target.file || typeof target.file !== "string") {
        throw new Error(
          `${name}.porterman.json: tunnel ${portStr} envFiles[${i}] has missing or invalid "file"`
        );
      }

      if (target.filePath !== undefined && typeof target.filePath !== "string") {
        throw new Error(
          `${name}.porterman.json: tunnel ${portStr} envFiles[${i}] "filePath" must be a string`
        );
      }

      if (target.type !== undefined && target.type !== "env" && target.type !== "json") {
        throw new Error(
          `${name}.porterman.json: tunnel ${portStr} envFiles[${i}] "type" must be "env" or "json"`
        );
      }

      if (!target.variables || typeof target.variables !== "object") {
        throw new Error(
          `${name}.porterman.json: tunnel ${portStr} envFiles[${i}] has missing or invalid "variables"`
        );
      }
    }
  }

  return config;
}

export function createBackup(config: SettingsConfig): BackupManifest {
  const entries: BackupEntry[] = [];
  const createdFiles: string[] = [];
  const checkedFiles = new Set<string>();
  const seenVariables = new Map<string, Set<string>>();

  for (const [, tunnel] of Object.entries(config.tunnels)) {
    for (const target of tunnel.envFiles) {
      const targetPath = resolveTargetPath(target);
      const fileType = resolveFileType(target);
      const fileExists = existsSync(targetPath);
      const isNewFile = !fileExists && !checkedFiles.has(targetPath);

      if (isNewFile) {
        createdFiles.push(targetPath);
      }

      if (!seenVariables.has(targetPath)) {
        seenVariables.set(targetPath, new Set());
      }
      const fileSeenVars = seenVariables.get(targetPath)!;

      if (fileType === "env") {
        let parsed = new Map<string, { value: string; line: number }>();
        if (fileExists) {
          try {
            const content = readFileSync(targetPath, "utf-8");
            parsed = parseEnvFile(content);
          } catch {}
        }

        for (const variable of Object.keys(target.variables)) {
          if (fileSeenVars.has(variable)) continue;
          fileSeenVars.add(variable);

          const existing = parsed.get(variable);
          entries.push({
            file: targetPath,
            fileType: "env",
            variable,
            originalValue: existing ? existing.value : null,
            fileCreated: isNewFile,
          });
        }
      } else {
        let jsonData: Record<string, unknown> = {};
        if (fileExists) {
          try {
            const content = readFileSync(targetPath, "utf-8");
            jsonData = JSON.parse(content);
          } catch {}
        }

        for (const variable of Object.keys(target.variables)) {
          if (fileSeenVars.has(variable)) continue;
          fileSeenVars.add(variable);

          const existing = getJsonValue(jsonData, variable);
          entries.push({
            file: targetPath,
            fileType: "json",
            variable,
            originalValue: existing !== undefined ? (existing as string | number) : null,
            fileCreated: isNewFile,
          });
        }
      }

      checkedFiles.add(targetPath);
    }
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    createdFiles,
    entries,
  };
}

export function writeBackupFile(name: string, manifest: BackupManifest): void {
  const filePath = resolve(`.${name}.porterman.backup.env`);
  writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

export function readBackupFile(name: string): BackupManifest | null {
  const filePath = resolve(`.${name}.porterman.backup.env`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    const corruptedPath = filePath + ".corrupted";
    try {
      renameSync(filePath, corruptedPath);
      logger.warn(
        `Backup file was corrupted, renamed to ${corruptedPath}`
      );
    } catch {
      logger.warn("Backup file was corrupted and could not be recovered");
    }
    return null;
  }
}

export async function applySettings(
  config: SettingsConfig,
  tunnelUrls: Map<number, string>
): Promise<void> {
  // Group all updates by resolved file path to batch writes
  const envFileUpdates = new Map<string, Array<{ key: string; value: string }>>();
  const jsonFileUpdates = new Map<string, Array<{ key: string; value: string | number }>>();

  for (const [portStr, tunnel] of Object.entries(config.tunnels)) {
    const port = parseInt(portStr, 10);
    const url = tunnelUrls.get(port);

    if (!url) {
      logger.warn(
        `Tunnel for port ${port} has no URL — skipping file targets for port ${port}`
      );
      continue;
    }

    const hostname = new URL(url).hostname;

    for (const target of tunnel.envFiles) {
      const targetPath = resolveTargetPath(target);
      const fileType = resolveFileType(target);

      for (const [key, rawValue] of Object.entries(target.variables)) {
        let value: string | number;
        if (rawValue === "$tunnelUrl") {
          value = url;
        } else if (rawValue === "$tunnelHostname") {
          value = hostname;
        } else {
          value = rawValue;
        }

        if (fileType === "env") {
          if (!envFileUpdates.has(targetPath)) {
            envFileUpdates.set(targetPath, []);
          }
          envFileUpdates.get(targetPath)!.push({ key, value: String(value) });
        } else {
          if (!jsonFileUpdates.has(targetPath)) {
            jsonFileUpdates.set(targetPath, []);
          }
          jsonFileUpdates.get(targetPath)!.push({ key, value });
        }
      }
    }
  }

  // Apply env file updates
  for (const [targetPath, updates] of envFileUpdates) {
    let content = "";
    if (existsSync(targetPath)) {
      try {
        content = await readFile(targetPath, "utf-8");
      } catch (err) {
        logger.error(
          `Failed to read ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
    }

    for (const { key, value } of updates) {
      content = setEnvVariable(content, key, value);
    }

    try {
      await writeFile(targetPath, content);
    } catch (err) {
      logger.error(
        `Failed to write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Apply JSON file updates
  for (const [targetPath, updates] of jsonFileUpdates) {
    let jsonData: Record<string, unknown> = {};
    if (existsSync(targetPath)) {
      try {
        const content = await readFile(targetPath, "utf-8");
        jsonData = JSON.parse(content);
      } catch (err) {
        if (existsSync(targetPath)) {
          logger.error(
            `Failed to parse JSON in ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }
    }

    for (const { key, value } of updates) {
      setJsonValue(jsonData, key, value);
    }

    try {
      await writeFile(targetPath, JSON.stringify(jsonData, null, 2) + "\n");
    } catch (err) {
      logger.error(
        `Failed to write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export async function restoreFromBackup(
  name: string,
  manifest: BackupManifest
): Promise<void> {
  const backupPath = resolve(`.${name}.porterman.backup.env`);

  const createdFilesSet = new Set(manifest.createdFiles);

  // Group entries by file for batched operations
  const fileEntries = new Map<string, BackupEntry[]>();
  for (const entry of manifest.entries) {
    if (!fileEntries.has(entry.file)) {
      fileEntries.set(entry.file, []);
    }
    fileEntries.get(entry.file)!.push(entry);
  }

  for (const [filePath, entries] of fileEntries) {
    if (createdFilesSet.has(filePath)) {
      try {
        if (existsSync(filePath)) {
          await unlink(filePath);
        }
      } catch {}
      continue;
    }

    if (!existsSync(filePath)) continue;

    const fileType = entries[0].fileType;

    if (fileType === "env") {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.originalValue === null) {
          content = removeEnvVariable(content, entry.variable);
        } else {
          content = setEnvVariable(content, entry.variable, String(entry.originalValue));
        }
      }

      try {
        await writeFile(filePath, content);
      } catch {}
    } else {
      let jsonData: Record<string, unknown>;
      try {
        const content = await readFile(filePath, "utf-8");
        jsonData = JSON.parse(content);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.originalValue === null) {
          deleteJsonValue(jsonData, entry.variable);
        } else {
          setJsonValue(jsonData, entry.variable, entry.originalValue);
        }
      }

      try {
        await writeFile(filePath, JSON.stringify(jsonData, null, 2) + "\n");
      } catch {}
    }
  }

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
