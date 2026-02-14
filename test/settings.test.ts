import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  loadSettings,
  createBackup,
  applySettings,
  restoreFromBackup,
  writeBackupFile,
  readBackupFile,
  parseEnvFile,
  setEnvVariable,
  removeEnvVariable,
  type SettingsConfig,
  type BackupManifest,
} from "../src/settings.js";

// ── Test helpers ───────────────────────────────────────────────────────

const TEST_ENV_FILE = resolve(".env.settings.test");
const TEST_ENV_FILE_2 = resolve(".env.settings.test2");
const TEST_SETTINGS_FILE = resolve("test-cfg.porterman.json");
const TEST_BACKUP_FILE = resolve(".test-cfg.porterman.backup.env");

async function cleanup() {
  for (const f of [
    TEST_ENV_FILE,
    TEST_ENV_FILE_2,
    TEST_SETTINGS_FILE,
    TEST_BACKUP_FILE,
    resolve(".corrupted-cfg.porterman.backup.env"),
    resolve(".corrupted-cfg.porterman.backup.env.corrupted"),
  ]) {
    try {
      await unlink(f);
    } catch {}
  }
}

// ── parseEnvFile ───────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses basic KEY=VALUE lines", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    const result = parseEnvFile(content);
    expect(result.get("FOO")?.value).toBe("bar");
    expect(result.get("BAZ")?.value).toBe("qux");
  });

  it("handles double-quoted values", () => {
    const content = 'MY_VAR="hello world"\n';
    const result = parseEnvFile(content);
    expect(result.get("MY_VAR")?.value).toBe("hello world");
  });

  it("handles single-quoted values", () => {
    const content = "MY_VAR='hello world'\n";
    const result = parseEnvFile(content);
    expect(result.get("MY_VAR")?.value).toBe("hello world");
  });

  it("skips comments and blank lines", () => {
    const content = "# This is a comment\n\nFOO=bar\n# Another comment\nBAZ=qux\n";
    const result = parseEnvFile(content);
    expect(result.size).toBe(2);
    expect(result.get("FOO")?.value).toBe("bar");
    expect(result.get("BAZ")?.value).toBe("qux");
  });

  it("handles values with equals signs", () => {
    const content = "URL=https://example.com?foo=bar&baz=1\n";
    const result = parseEnvFile(content);
    expect(result.get("URL")?.value).toBe("https://example.com?foo=bar&baz=1");
  });

  it("tracks line numbers", () => {
    const content = "# comment\nFOO=bar\n\nBAZ=qux\n";
    const result = parseEnvFile(content);
    expect(result.get("FOO")?.line).toBe(1);
    expect(result.get("BAZ")?.line).toBe(3);
  });

  it("handles empty file", () => {
    const result = parseEnvFile("");
    expect(result.size).toBe(0);
  });

  it("handles empty values", () => {
    const content = "FOO=\n";
    const result = parseEnvFile(content);
    expect(result.get("FOO")?.value).toBe("");
  });
});

// ── setEnvVariable ─────────────────────────────────────────────────────

describe("setEnvVariable", () => {
  it("replaces existing variable in-place", () => {
    const content = "FOO=old\nBAR=keep\n";
    const result = setEnvVariable(content, "FOO", "new");
    expect(result).toBe("FOO=new\nBAR=keep\n");
  });

  it("prepends new variable to top", () => {
    const content = "FOO=bar\n";
    const result = setEnvVariable(content, "NEW_VAR", "value");
    expect(result).toBe("NEW_VAR=value\nFOO=bar\n");
  });

  it("handles empty content", () => {
    const result = setEnvVariable("", "FOO", "bar");
    expect(result).toBe("FOO=bar\n");
  });

  it("preserves other lines when replacing", () => {
    const content = "# comment\nFOO=old\nBAR=keep\n";
    const result = setEnvVariable(content, "FOO", "new");
    expect(result).toContain("# comment");
    expect(result).toContain("FOO=new");
    expect(result).toContain("BAR=keep");
  });

  it("replaces the correct variable when multiple exist", () => {
    const content = "AAA=1\nBBB=2\nCCC=3\n";
    const result = setEnvVariable(content, "BBB", "changed");
    expect(result).toBe("AAA=1\nBBB=changed\nCCC=3\n");
  });
});

// ── removeEnvVariable ──────────────────────────────────────────────────

describe("removeEnvVariable", () => {
  it("removes a variable line", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    const result = removeEnvVariable(content, "FOO");
    expect(result).not.toContain("FOO");
    expect(result).toContain("BAZ=qux");
  });

  it("does not leave double blank lines", () => {
    const content = "AAA=1\n\nFOO=bar\n\nBBB=2\n";
    const result = removeEnvVariable(content, "FOO");
    expect(result).not.toMatch(/\n\n\n/);
  });

  it("handles removing from single-line content", () => {
    const content = "FOO=bar\n";
    const result = removeEnvVariable(content, "FOO");
    expect(result.trim()).toBe("");
  });

  it("does nothing if variable not found", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    const result = removeEnvVariable(content, "MISSING");
    expect(result).toContain("FOO=bar");
    expect(result).toContain("BAZ=qux");
  });

  it("removes leading blank lines after removal", () => {
    const content = "FOO=bar\nBAZ=qux\n";
    const result = removeEnvVariable(content, "FOO");
    expect(result).not.toMatch(/^\n/);
  });
});

// ── loadSettings ───────────────────────────────────────────────────────

describe("loadSettings", () => {
  afterEach(cleanup);

  it("loads valid config", () => {
    const config = {
      tunnels: {
        "3000": {
          envFile: ".env",
          variables: { PUBLIC_API_URL: "$tunnelUrl", PORT: 443 },
        },
      },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));

    const result = loadSettings("test-cfg");
    expect(result.tunnels["3000"].envFile).toBe(".env");
    expect(result.tunnels["3000"].variables.PUBLIC_API_URL).toBe("$tunnelUrl");
    expect(result.tunnels["3000"].variables.PORT).toBe(443);
  });

  it("throws on missing file", () => {
    expect(() => loadSettings("nonexistent")).toThrow(
      "nonexistent.porterman.json not found in current directory"
    );
  });

  it("throws on invalid JSON", () => {
    writeFileSync(TEST_SETTINGS_FILE, "not json{");
    expect(() => loadSettings("test-cfg")).toThrow("invalid JSON");
  });

  it("throws on invalid port", () => {
    const config = {
      tunnels: {
        "99999": {
          envFile: ".env",
          variables: { FOO: "$tunnelUrl" },
        },
      },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow("port '99999' is invalid");
  });

  it("throws on missing tunnels object", () => {
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({}));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "tunnels"');
  });

  it("throws on missing envFile", () => {
    const config = {
      tunnels: {
        "3000": {
          variables: { FOO: "bar" },
        },
      },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "envFile"');
  });

  it("throws on missing variables", () => {
    const config = {
      tunnels: {
        "3000": {
          envFile: ".env",
        },
      },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "variables"');
  });
});

// ── createBackup ───────────────────────────────────────────────────────

describe("createBackup", () => {
  afterEach(cleanup);

  it("captures existing variable values", () => {
    writeFileSync(TEST_ENV_FILE, "PUBLIC_API_URL=http://localhost:3000\nPORT=80\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { PUBLIC_API_URL: "$tunnelUrl", PORT: 443 },
        },
      },
    };

    const manifest = createBackup(config);
    const apiEntry = manifest.entries.find(
      (e) => e.variable === "PUBLIC_API_URL"
    );
    const portEntry = manifest.entries.find((e) => e.variable === "PORT");

    expect(apiEntry?.originalValue).toBe("http://localhost:3000");
    expect(portEntry?.originalValue).toBe("80");
    expect(apiEntry?.envFileCreated).toBe(false);
  });

  it("marks null for missing variables", () => {
    writeFileSync(TEST_ENV_FILE, "EXISTING=value\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { NEW_VAR: "$tunnelUrl" },
        },
      },
    };

    const manifest = createBackup(config);
    const entry = manifest.entries.find((e) => e.variable === "NEW_VAR");
    expect(entry?.originalValue).toBeNull();
  });

  it("tracks created env files", () => {
    // Don't create the env file — it doesn't exist
    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { FOO: "$tunnelUrl" },
        },
      },
    };

    const manifest = createBackup(config);
    expect(manifest.createdEnvFiles).toContain(TEST_ENV_FILE);
    expect(manifest.entries[0].envFileCreated).toBe(true);
  });

  it("handles multiple tunnels with same env file", () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { API_URL: "$tunnelUrl" },
        },
        "5177": {
          envFile: TEST_ENV_FILE,
          variables: { FRONTEND_URL: "$tunnelUrl" },
        },
      },
    };

    const manifest = createBackup(config);
    expect(manifest.entries).toHaveLength(2);
    const apiEntry = manifest.entries.find((e) => e.variable === "API_URL");
    const frontendEntry = manifest.entries.find(
      (e) => e.variable === "FRONTEND_URL"
    );
    expect(apiEntry?.originalValue).toBe("http://localhost:3000");
    expect(frontendEntry?.originalValue).toBeNull();
  });
});

// ── writeBackupFile / readBackupFile ───────────────────────────────────

describe("writeBackupFile / readBackupFile", () => {
  afterEach(cleanup);

  it("writes and reads backup manifest", () => {
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: ".env",
          variable: "FOO",
          originalValue: "bar",
          envFileCreated: false,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    const read = readBackupFile("test-cfg");
    expect(read).toEqual(manifest);
  });

  it("returns null for missing backup", () => {
    const result = readBackupFile("nonexistent");
    expect(result).toBeNull();
  });

  it("handles corrupted backup file", () => {
    const backupPath = resolve(".corrupted-cfg.porterman.backup.env");
    writeFileSync(backupPath, "not valid json{{{");

    const result = readBackupFile("corrupted-cfg");
    expect(result).toBeNull();
    // Should have been renamed to .corrupted
    expect(existsSync(backupPath + ".corrupted")).toBe(true);
  });
});

// ── applySettings ──────────────────────────────────────────────────────

describe("applySettings", () => {
  afterEach(cleanup);

  it("replaces $tunnelUrl with actual URL", async () => {
    writeFileSync(TEST_ENV_FILE, "PUBLIC_API_URL=http://localhost:3000\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { PUBLIC_API_URL: "$tunnelUrl" },
        },
      },
    };

    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain(
      "PUBLIC_API_URL=https://abc.trycloudflare.com"
    );
  });

  it("writes static values as-is", async () => {
    writeFileSync(TEST_ENV_FILE, "PORT=80\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { PORT: 443 },
        },
      },
    };

    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("PORT=443");
  });

  it("prepends new variables to top", async () => {
    writeFileSync(TEST_ENV_FILE, "EXISTING=value\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { NEW_VAR: "$tunnelUrl" },
        },
      },
    };

    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("NEW_VAR=https://abc.trycloudflare.com");
    // New var should appear before existing content
    const newIdx = content.indexOf("NEW_VAR=");
    const existIdx = content.indexOf("EXISTING=");
    expect(newIdx).toBeLessThan(existIdx);
  });

  it("creates missing env files", async () => {
    // Ensure env file doesn't exist
    try {
      await unlink(TEST_ENV_FILE);
    } catch {}

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { FOO: "$tunnelUrl" },
        },
      },
    };

    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    expect(existsSync(TEST_ENV_FILE)).toBe(true);
    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("FOO=https://abc.trycloudflare.com");
  });

  it("skips port with no tunnel URL", async () => {
    writeFileSync(TEST_ENV_FILE, "FOO=original\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { FOO: "$tunnelUrl" },
        },
      },
    };

    // Empty tunnel URLs — port 3000 has no URL
    const tunnelUrls = new Map<number, string>();
    await applySettings(config, tunnelUrls);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toBe("FOO=original\n");
  });

  it("handles multiple tunnels writing to same env file", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { API_URL: "$tunnelUrl" },
        },
        "5177": {
          envFile: TEST_ENV_FILE,
          variables: { FRONTEND_URL: "$tunnelUrl" },
        },
      },
    };

    const tunnelUrls = new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]);
    await applySettings(config, tunnelUrls);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=https://abc.trycloudflare.com");
    expect(content).toContain("FRONTEND_URL=https://def.trycloudflare.com");
  });

  it("handles tunnels writing to different env files", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");
    writeFileSync(TEST_ENV_FILE_2, "FRONTEND_URL=http://localhost:5177\n");

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { API_URL: "$tunnelUrl" },
        },
        "5177": {
          envFile: TEST_ENV_FILE_2,
          variables: { FRONTEND_URL: "$tunnelUrl" },
        },
      },
    };

    const tunnelUrls = new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]);
    await applySettings(config, tunnelUrls);

    const content1 = await readFile(TEST_ENV_FILE, "utf-8");
    const content2 = await readFile(TEST_ENV_FILE_2, "utf-8");
    expect(content1).toContain("API_URL=https://abc.trycloudflare.com");
    expect(content2).toContain("FRONTEND_URL=https://def.trycloudflare.com");
  });
});

// ── restoreFromBackup ──────────────────────────────────────────────────

describe("restoreFromBackup", () => {
  afterEach(cleanup);

  it("restores original values", async () => {
    writeFileSync(
      TEST_ENV_FILE,
      "PUBLIC_API_URL=https://abc.trycloudflare.com\n"
    );

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "PUBLIC_API_URL",
          originalValue: "http://localhost:3000",
          envFileCreated: false,
        },
      ],
    };

    // Write backup file so restore can delete it
    writeBackupFile("test-cfg", manifest);

    await restoreFromBackup("test-cfg", manifest);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("PUBLIC_API_URL=http://localhost:3000");
    expect(content).not.toContain("trycloudflare");
  });

  it("removes variables that were added by porterman", async () => {
    writeFileSync(
      TEST_ENV_FILE,
      "NEW_VAR=https://abc.trycloudflare.com\nEXISTING=keep\n"
    );

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "NEW_VAR",
          originalValue: null,
          envFileCreated: false,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).not.toContain("NEW_VAR");
    expect(content).toContain("EXISTING=keep");
  });

  it("deletes env files created by porterman", async () => {
    writeFileSync(TEST_ENV_FILE, "FOO=https://abc.trycloudflare.com\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [TEST_ENV_FILE],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "FOO",
          originalValue: null,
          envFileCreated: true,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    expect(existsSync(TEST_ENV_FILE)).toBe(false);
  });

  it("deletes the backup file after restore", async () => {
    writeFileSync(
      TEST_ENV_FILE,
      "FOO=https://abc.trycloudflare.com\n"
    );

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "FOO",
          originalValue: "original",
          envFileCreated: false,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    expect(existsSync(TEST_BACKUP_FILE)).toBe(true);

    await restoreFromBackup("test-cfg", manifest);

    expect(existsSync(TEST_BACKUP_FILE)).toBe(false);
  });

  it("handles multiple entries for same env file", async () => {
    writeFileSync(
      TEST_ENV_FILE,
      "API_URL=https://abc.trycloudflare.com\nNEW_VAR=https://def.trycloudflare.com\nEXISTING=keep\n"
    );

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "API_URL",
          originalValue: "http://localhost:3000",
          envFileCreated: false,
        },
        {
          envFile: TEST_ENV_FILE,
          variable: "NEW_VAR",
          originalValue: null,
          envFileCreated: false,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=http://localhost:3000");
    expect(content).not.toContain("NEW_VAR");
    expect(content).toContain("EXISTING=keep");
  });
});

// ── Round-trip tests ───────────────────────────────────────────────────

describe("round-trip: apply then restore", () => {
  afterEach(cleanup);

  it("leaves env file identical to original after restore", async () => {
    const original = "APP_NAME=MyApp\nDB_HOST=localhost\nPORT=3000\n";
    writeFileSync(TEST_ENV_FILE, original);

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { APP_URL: "$tunnelUrl", PORT: 443 },
        },
      },
    };

    // Create backup
    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    // Apply settings
    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    // Verify settings were applied
    let content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("APP_URL=https://abc.trycloudflare.com");
    expect(content).toContain("PORT=443");

    // Restore
    await restoreFromBackup("test-cfg", manifest);

    // Verify original content is restored
    content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("APP_NAME=MyApp");
    expect(content).toContain("DB_HOST=localhost");
    expect(content).toContain("PORT=3000");
    expect(content).not.toContain("APP_URL");
    expect(content).not.toContain("trycloudflare");
    expect(content).not.toContain("443");
  });

  it("round-trips correctly when env file is created by porterman", async () => {
    // Ensure file doesn't exist
    try {
      await unlink(TEST_ENV_FILE);
    } catch {}

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: { MY_URL: "$tunnelUrl" },
        },
      },
    };

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    const tunnelUrls = new Map([[3000, "https://abc.trycloudflare.com"]]);
    await applySettings(config, tunnelUrls);

    expect(existsSync(TEST_ENV_FILE)).toBe(true);

    await restoreFromBackup("test-cfg", manifest);

    // File should be deleted since porterman created it
    expect(existsSync(TEST_ENV_FILE)).toBe(false);
  });

  it("round-trips correctly with multiple tunnels and same env file", async () => {
    const original = "API_URL=http://localhost:3000\nFRONTEND_URL=http://localhost:5177\n";
    writeFileSync(TEST_ENV_FILE, original);

    const config: SettingsConfig = {
      tunnels: {
        "3000": {
          envFile: TEST_ENV_FILE,
          variables: {
            API_URL: "$tunnelUrl",
            REVERB_PORT: 443,
          },
        },
        "5177": {
          envFile: TEST_ENV_FILE,
          variables: { FRONTEND_URL: "$tunnelUrl" },
        },
      },
    };

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    const tunnelUrls = new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]);
    await applySettings(config, tunnelUrls);

    // Verify applied
    let content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=https://abc.trycloudflare.com");
    expect(content).toContain("REVERB_PORT=443");
    expect(content).toContain("FRONTEND_URL=https://def.trycloudflare.com");

    // Restore
    await restoreFromBackup("test-cfg", manifest);

    content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=http://localhost:3000");
    expect(content).toContain("FRONTEND_URL=http://localhost:5177");
    expect(content).not.toContain("REVERB_PORT");
    expect(content).not.toContain("trycloudflare");
  });
});

// ── Crash recovery ─────────────────────────────────────────────────────

describe("crash recovery", () => {
  afterEach(cleanup);

  it("backup file exists on startup — restore then proceed", async () => {
    // Simulate a crash: env file was modified, backup exists
    writeFileSync(
      TEST_ENV_FILE,
      "API_URL=https://old-tunnel.trycloudflare.com\nADDED_VAR=some-value\n"
    );

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdEnvFiles: [],
      entries: [
        {
          envFile: TEST_ENV_FILE,
          variable: "API_URL",
          originalValue: "http://localhost:3000",
          envFileCreated: false,
        },
        {
          envFile: TEST_ENV_FILE,
          variable: "ADDED_VAR",
          originalValue: null,
          envFileCreated: false,
        },
      ],
    };

    writeBackupFile("test-cfg", manifest);

    // Simulate startup: detect backup and restore
    const existingBackup = readBackupFile("test-cfg");
    expect(existingBackup).not.toBeNull();

    await restoreFromBackup("test-cfg", existingBackup!);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=http://localhost:3000");
    expect(content).not.toContain("ADDED_VAR");
    expect(content).not.toContain("trycloudflare");

    // Backup file should be cleaned up
    expect(existsSync(TEST_BACKUP_FILE)).toBe(false);
  });
});
