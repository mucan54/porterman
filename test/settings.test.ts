import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadSettings,
  createBackup,
  applySettings,
  restoreFromBackup,
  writeBackupFile,
  readBackupFile,
  resolveFileType,
  resolveTargetPath,
  parseEnvFile,
  setEnvVariable,
  removeEnvVariable,
  getJsonValue,
  setJsonValue,
  deleteJsonValue,
  type SettingsConfig,
  type BackupManifest,
  type FileTarget,
} from "../src/settings.js";

// ── Test helpers ───────────────────────────────────────────────────────

const TEST_ENV_FILE = resolve(".env.settings.test");
const TEST_ENV_FILE_2 = resolve(".env.settings.test2");
const TEST_JSON_FILE = resolve("config.settings.test.json");
const TEST_JSON_FILE_2 = resolve("config.settings.test2.json");
const TEST_SETTINGS_FILE = resolve("test-cfg.porterman.json");
const TEST_BACKUP_FILE = resolve(".test-cfg.porterman.backup.env");

async function cleanup() {
  for (const f of [
    TEST_ENV_FILE,
    TEST_ENV_FILE_2,
    TEST_JSON_FILE,
    TEST_JSON_FILE_2,
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

function makeConfig(tunnels: SettingsConfig["tunnels"], opts?: { cleanup?: boolean; verbose?: boolean }): SettingsConfig {
  return { tunnels, ...opts };
}

// ── parseEnvFile ───────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  it("parses basic KEY=VALUE lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(result.get("FOO")?.value).toBe("bar");
    expect(result.get("BAZ")?.value).toBe("qux");
  });

  it("handles double-quoted values", () => {
    const result = parseEnvFile('MY_VAR="hello world"\n');
    expect(result.get("MY_VAR")?.value).toBe("hello world");
  });

  it("handles single-quoted values", () => {
    const result = parseEnvFile("MY_VAR='hello world'\n");
    expect(result.get("MY_VAR")?.value).toBe("hello world");
  });

  it("skips comments and blank lines", () => {
    const result = parseEnvFile("# comment\n\nFOO=bar\n# another\nBAZ=qux\n");
    expect(result.size).toBe(2);
    expect(result.get("FOO")?.value).toBe("bar");
    expect(result.get("BAZ")?.value).toBe("qux");
  });

  it("handles values with equals signs", () => {
    const result = parseEnvFile("URL=https://example.com?foo=bar&baz=1\n");
    expect(result.get("URL")?.value).toBe("https://example.com?foo=bar&baz=1");
  });

  it("tracks line numbers", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n\nBAZ=qux\n");
    expect(result.get("FOO")?.line).toBe(1);
    expect(result.get("BAZ")?.line).toBe(3);
  });

  it("handles empty file", () => {
    expect(parseEnvFile("").size).toBe(0);
  });

  it("handles empty values", () => {
    const result = parseEnvFile("FOO=\n");
    expect(result.get("FOO")?.value).toBe("");
  });
});

// ── setEnvVariable ─────────────────────────────────────────────────────

describe("setEnvVariable", () => {
  it("replaces existing variable in-place", () => {
    expect(setEnvVariable("FOO=old\nBAR=keep\n", "FOO", "new")).toBe("FOO=new\nBAR=keep\n");
  });

  it("prepends new variable to top", () => {
    expect(setEnvVariable("FOO=bar\n", "NEW_VAR", "value")).toBe("NEW_VAR=value\nFOO=bar\n");
  });

  it("handles empty content", () => {
    expect(setEnvVariable("", "FOO", "bar")).toBe("FOO=bar\n");
  });

  it("preserves other lines when replacing", () => {
    const result = setEnvVariable("# comment\nFOO=old\nBAR=keep\n", "FOO", "new");
    expect(result).toContain("# comment");
    expect(result).toContain("FOO=new");
    expect(result).toContain("BAR=keep");
  });

  it("replaces the correct variable when multiple exist", () => {
    expect(setEnvVariable("AAA=1\nBBB=2\nCCC=3\n", "BBB", "changed")).toBe("AAA=1\nBBB=changed\nCCC=3\n");
  });
});

// ── removeEnvVariable ──────────────────────────────────────────────────

describe("removeEnvVariable", () => {
  it("removes a variable line", () => {
    const result = removeEnvVariable("FOO=bar\nBAZ=qux\n", "FOO");
    expect(result).not.toContain("FOO");
    expect(result).toContain("BAZ=qux");
  });

  it("does not leave double blank lines", () => {
    expect(removeEnvVariable("AAA=1\n\nFOO=bar\n\nBBB=2\n", "FOO")).not.toMatch(/\n\n\n/);
  });

  it("handles removing from single-line content", () => {
    expect(removeEnvVariable("FOO=bar\n", "FOO").trim()).toBe("");
  });

  it("does nothing if variable not found", () => {
    const result = removeEnvVariable("FOO=bar\nBAZ=qux\n", "MISSING");
    expect(result).toContain("FOO=bar");
    expect(result).toContain("BAZ=qux");
  });

  it("removes leading blank lines after removal", () => {
    expect(removeEnvVariable("FOO=bar\nBAZ=qux\n", "FOO")).not.toMatch(/^\n/);
  });
});

// ── JSON helpers ───────────────────────────────────────────────────────

describe("getJsonValue", () => {
  it("traverses dot paths", () => {
    expect(getJsonValue({ a: { b: 1 } }, "a.b")).toBe(1);
  });

  it("returns undefined for missing paths", () => {
    expect(getJsonValue({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });

  it("returns undefined when intermediate is not an object", () => {
    expect(getJsonValue({ a: "string" }, "a.b")).toBeUndefined();
  });

  it("handles top-level keys", () => {
    expect(getJsonValue({ topLevel: "value" }, "topLevel")).toBe("value");
  });

  it("handles deep paths", () => {
    expect(getJsonValue({ a: { b: { c: { d: 42 } } } }, "a.b.c.d")).toBe(42);
  });
});

describe("setJsonValue", () => {
  it("sets a top-level key", () => {
    const data: Record<string, unknown> = {};
    setJsonValue(data, "foo", "bar");
    expect(data.foo).toBe("bar");
  });

  it("creates intermediate objects", () => {
    const data: Record<string, unknown> = {};
    setJsonValue(data, "a.b.c", 443);
    expect(data).toEqual({ a: { b: { c: 443 } } });
  });

  it("preserves sibling keys", () => {
    const data: Record<string, unknown> = { a: { existing: "keep", b: 1 } };
    setJsonValue(data, "a.b", 2);
    expect(data).toEqual({ a: { existing: "keep", b: 2 } });
  });

  it("overwrites non-object intermediate with object", () => {
    const data: Record<string, unknown> = { a: "string" };
    setJsonValue(data, "a.b", 1);
    expect(data).toEqual({ a: { b: 1 } });
  });

  it("preserves number types", () => {
    const data: Record<string, unknown> = {};
    setJsonValue(data, "port", 443);
    expect(data.port).toBe(443);
    expect(typeof data.port).toBe("number");
  });
});

describe("deleteJsonValue", () => {
  it("removes key and preserves siblings", () => {
    const data: Record<string, unknown> = { a: { b: 1, c: 2 } };
    deleteJsonValue(data, "a.b");
    expect(data).toEqual({ a: { c: 2 } });
  });

  it("leaves empty parent objects", () => {
    const data: Record<string, unknown> = { a: { b: 1 } };
    deleteJsonValue(data, "a.b");
    expect(data).toEqual({ a: {} });
  });

  it("handles non-existent paths gracefully", () => {
    const data: Record<string, unknown> = { a: 1 };
    deleteJsonValue(data, "x.y.z");
    expect(data).toEqual({ a: 1 });
  });

  it("removes top-level keys", () => {
    const data: Record<string, unknown> = { a: 1, b: 2 };
    deleteJsonValue(data, "a");
    expect(data).toEqual({ b: 2 });
  });
});

// ── resolveFileType ────────────────────────────────────────────────────

describe("resolveFileType", () => {
  it(".json extension → json", () => {
    expect(resolveFileType({ file: "config.json", variables: {} })).toBe("json");
  });

  it(".env extension → env", () => {
    expect(resolveFileType({ file: ".env", variables: {} })).toBe("env");
  });

  it(".env.local → env", () => {
    expect(resolveFileType({ file: ".env.local", variables: {} })).toBe("env");
  });

  it("explicit type overrides extension", () => {
    expect(resolveFileType({ file: "config.json", type: "env", variables: {} })).toBe("env");
  });

  it("explicit type env on non-standard extension", () => {
    expect(resolveFileType({ file: "config.yaml.bak", type: "env", variables: {} })).toBe("env");
  });
});

// ── resolveTargetPath ──────────────────────────────────────────────────

describe("resolveTargetPath", () => {
  it("no filePath → resolves from cwd", () => {
    const target: FileTarget = { file: ".env", variables: {} };
    expect(resolveTargetPath(target)).toBe(resolve(".env"));
  });

  it("relative filePath → resolves from cwd then joins", () => {
    const target: FileTarget = { file: ".env", filePath: "./subdir", variables: {} };
    expect(resolveTargetPath(target)).toBe(resolve("./subdir", ".env"));
  });

  it("empty string filePath → treated as no filePath", () => {
    const target: FileTarget = { file: ".env", filePath: "", variables: {} };
    expect(resolveTargetPath(target)).toBe(resolve(".env"));
  });

  it("absolute filePath → used directly", () => {
    const target: FileTarget = { file: "config.json", filePath: "/tmp/testdir", variables: {} };
    expect(resolveTargetPath(target)).toBe(resolve("/tmp/testdir", "config.json"));
  });
});

// ── loadSettings ───────────────────────────────────────────────────────

describe("loadSettings", () => {
  afterEach(cleanup);

  it("loads valid config with envFiles array", () => {
    const config = {
      tunnels: {
        "3000": {
          envFiles: [
            { file: ".env", variables: { PUBLIC_API_URL: "$tunnelUrl", PORT: 443 } },
          ],
        },
      },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));

    const result = loadSettings("test-cfg");
    expect(result.tunnels["3000"].envFiles[0].file).toBe(".env");
    expect(result.tunnels["3000"].envFiles[0].variables.PUBLIC_API_URL).toBe("$tunnelUrl");
    expect(result.tunnels["3000"].envFiles[0].variables.PORT).toBe(443);
  });

  it("loads config with optional cleanup and verbose", () => {
    const config = {
      tunnels: { "3000": { envFiles: [{ file: ".env", variables: { A: "b" } }] } },
      cleanup: false,
      verbose: true,
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));

    const result = loadSettings("test-cfg");
    expect(result.cleanup).toBe(false);
    expect(result.verbose).toBe(true);
  });

  it("throws on missing file", () => {
    expect(() => loadSettings("nonexistent")).toThrow("not found in current directory");
  });

  it("throws on invalid JSON", () => {
    writeFileSync(TEST_SETTINGS_FILE, "not json{");
    expect(() => loadSettings("test-cfg")).toThrow("invalid JSON");
  });

  it("throws on invalid port", () => {
    const config = {
      tunnels: { "99999": { envFiles: [{ file: ".env", variables: { FOO: "bar" } }] } },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow("port '99999' is invalid");
  });

  it("throws on missing tunnels object", () => {
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({}));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "tunnels"');
  });

  it("throws on missing envFiles array", () => {
    const config = { tunnels: { "3000": {} } };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "envFiles" array');
  });

  it("throws on missing file in envFiles entry", () => {
    const config = { tunnels: { "3000": { envFiles: [{ variables: { A: "b" } }] } } };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "file"');
  });

  it("throws on missing variables in envFiles entry", () => {
    const config = { tunnels: { "3000": { envFiles: [{ file: ".env" }] } } };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('missing or invalid "variables"');
  });

  it("throws on invalid type override", () => {
    const config = {
      tunnels: { "3000": { envFiles: [{ file: ".env", type: "xml", variables: { A: "b" } }] } },
    };
    writeFileSync(TEST_SETTINGS_FILE, JSON.stringify(config));
    expect(() => loadSettings("test-cfg")).toThrow('"type" must be "env" or "json"');
  });
});

// ── createBackup ───────────────────────────────────────────────────────

describe("createBackup", () => {
  afterEach(cleanup);

  it("captures existing env variable values", () => {
    writeFileSync(TEST_ENV_FILE, "PUBLIC_API_URL=http://localhost:3000\nPORT=80\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { PUBLIC_API_URL: "$tunnelUrl", PORT: 443 } }],
      },
    });

    const manifest = createBackup(config);
    const apiEntry = manifest.entries.find((e) => e.variable === "PUBLIC_API_URL");
    const portEntry = manifest.entries.find((e) => e.variable === "PORT");

    expect(apiEntry?.originalValue).toBe("http://localhost:3000");
    expect(portEntry?.originalValue).toBe("80");
    expect(apiEntry?.fileType).toBe("env");
    expect(apiEntry?.fileCreated).toBe(false);
  });

  it("captures existing JSON values via dot notation", () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ api: { url: "http://localhost:3000" }, port: 80 }));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "api.url": "$tunnelUrl", port: 443 } }],
      },
    });

    const manifest = createBackup(config);
    const apiEntry = manifest.entries.find((e) => e.variable === "api.url");
    const portEntry = manifest.entries.find((e) => e.variable === "port");

    expect(apiEntry?.originalValue).toBe("http://localhost:3000");
    expect(apiEntry?.fileType).toBe("json");
    expect(portEntry?.originalValue).toBe(80);
  });

  it("marks null for missing variables", () => {
    writeFileSync(TEST_ENV_FILE, "EXISTING=value\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { NEW_VAR: "$tunnelUrl" } }],
      },
    });

    const manifest = createBackup(config);
    expect(manifest.entries.find((e) => e.variable === "NEW_VAR")?.originalValue).toBeNull();
  });

  it("tracks files created by porterman", () => {
    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { FOO: "$tunnelUrl" } }],
      },
    });

    const manifest = createBackup(config);
    expect(manifest.createdFiles).toContain(resolve(TEST_ENV_FILE));
    expect(manifest.entries[0].fileCreated).toBe(true);
  });

  it("handles multiple tunnels targeting same file", () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");

    const config = makeConfig({
      "3000": { envFiles: [{ file: TEST_ENV_FILE, variables: { API_URL: "$tunnelUrl" } }] },
      "5177": { envFiles: [{ file: TEST_ENV_FILE, variables: { FRONTEND_URL: "$tunnelUrl" } }] },
    });

    const manifest = createBackup(config);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.find((e) => e.variable === "API_URL")?.originalValue).toBe("http://localhost:3000");
    expect(manifest.entries.find((e) => e.variable === "FRONTEND_URL")?.originalValue).toBeNull();
  });

  it("captures first encounter of duplicate variables only", () => {
    writeFileSync(TEST_ENV_FILE, "FOO=original\n");

    const config = makeConfig({
      "3000": {
        envFiles: [
          { file: TEST_ENV_FILE, variables: { FOO: "$tunnelUrl" } },
          { file: TEST_ENV_FILE, variables: { FOO: "other-value" } },
        ],
      },
    });

    const manifest = createBackup(config);
    const fooEntries = manifest.entries.filter((e) => e.variable === "FOO");
    expect(fooEntries).toHaveLength(1);
    expect(fooEntries[0].originalValue).toBe("original");
  });
});

// ── writeBackupFile / readBackupFile ───────────────────────────────────

describe("writeBackupFile / readBackupFile", () => {
  afterEach(cleanup);

  it("writes and reads backup manifest", () => {
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: ".env", fileType: "env", variable: "FOO", originalValue: "bar", fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    expect(readBackupFile("test-cfg")).toEqual(manifest);
  });

  it("returns null for missing backup", () => {
    expect(readBackupFile("nonexistent")).toBeNull();
  });

  it("handles corrupted backup file", () => {
    const backupPath = resolve(".corrupted-cfg.porterman.backup.env");
    writeFileSync(backupPath, "not valid json{{{");

    expect(readBackupFile("corrupted-cfg")).toBeNull();
    expect(existsSync(backupPath + ".corrupted")).toBe(true);
  });
});

// ── applySettings (env) ────────────────────────────────────────────────

describe("applySettings (env)", () => {
  afterEach(cleanup);

  it("replaces $tunnelUrl with actual URL", async () => {
    writeFileSync(TEST_ENV_FILE, "PUBLIC_API_URL=http://localhost:3000\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { PUBLIC_API_URL: "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(await readFile(TEST_ENV_FILE, "utf-8")).toContain("PUBLIC_API_URL=https://abc.trycloudflare.com");
  });

  it("replaces $tunnelHostname with hostname only", async () => {
    writeFileSync(TEST_ENV_FILE, "HOST=localhost\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { HOST: "$tunnelHostname" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(await readFile(TEST_ENV_FILE, "utf-8")).toContain("HOST=abc.trycloudflare.com");
  });

  it("writes static values as-is", async () => {
    writeFileSync(TEST_ENV_FILE, "PORT=80\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { PORT: 443 } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(await readFile(TEST_ENV_FILE, "utf-8")).toContain("PORT=443");
  });

  it("prepends new variables to top of existing env file", async () => {
    writeFileSync(TEST_ENV_FILE, "EXISTING=value\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { NEW_VAR: "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content.indexOf("NEW_VAR=")).toBeLessThan(content.indexOf("EXISTING="));
  });

  it("creates missing env files", async () => {
    try { await unlink(TEST_ENV_FILE); } catch {}

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { FOO: "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(existsSync(TEST_ENV_FILE)).toBe(true);
    expect(await readFile(TEST_ENV_FILE, "utf-8")).toContain("FOO=https://abc.trycloudflare.com");
  });

  it("skips ports with failed tunnels (no URL)", async () => {
    writeFileSync(TEST_ENV_FILE, "FOO=original\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { FOO: "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map<number, string>());
    expect(await readFile(TEST_ENV_FILE, "utf-8")).toBe("FOO=original\n");
  });

  it("handles multiple tunnels writing to same env file", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");

    const config = makeConfig({
      "3000": { envFiles: [{ file: TEST_ENV_FILE, variables: { API_URL: "$tunnelUrl" } }] },
      "5177": { envFiles: [{ file: TEST_ENV_FILE, variables: { FRONTEND_URL: "$tunnelUrl" } }] },
    });

    await applySettings(config, new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]));

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=https://abc.trycloudflare.com");
    expect(content).toContain("FRONTEND_URL=https://def.trycloudflare.com");
  });

  it("handles tunnels writing to different env files", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");
    writeFileSync(TEST_ENV_FILE_2, "FRONTEND_URL=http://localhost:5177\n");

    const config = makeConfig({
      "3000": { envFiles: [{ file: TEST_ENV_FILE, variables: { API_URL: "$tunnelUrl" } }] },
      "5177": { envFiles: [{ file: TEST_ENV_FILE_2, variables: { FRONTEND_URL: "$tunnelUrl" } }] },
    });

    await applySettings(config, new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]));

    expect(await readFile(TEST_ENV_FILE, "utf-8")).toContain("API_URL=https://abc.trycloudflare.com");
    expect(await readFile(TEST_ENV_FILE_2, "utf-8")).toContain("FRONTEND_URL=https://def.trycloudflare.com");
  });
});

// ── applySettings (json) ───────────────────────────────────────────────

describe("applySettings (json)", () => {
  afterEach(cleanup);

  it("sets dot-notated paths in existing JSON", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ api: { url: "http://localhost:3000" } }, null, 2));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "api.url": "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.api.url).toBe("https://abc.trycloudflare.com");
  });

  it("creates intermediate objects for deep paths", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({}, null, 2));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "deep.nested.key": "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.deep.nested.key).toBe("https://abc.trycloudflare.com");
  });

  it("creates missing JSON files with {}", async () => {
    try { await unlink(TEST_JSON_FILE); } catch {}

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "api.url": "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(existsSync(TEST_JSON_FILE)).toBe(true);
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.api.url).toBe("https://abc.trycloudflare.com");
  });

  it("preserves number types (443 stays number)", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({}, null, 2));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "reverb.port": 443 } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.reverb.port).toBe(443);
    expect(typeof data.reverb.port).toBe("number");
  });

  it("replaces $tunnelHostname in JSON", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({}, null, 2));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "reverb.host": "$tunnelHostname" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.reverb.host).toBe("abc.trycloudflare.com");
  });

  it("preserves other keys in JSON file", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ existing: "keep", api: { version: 2 } }, null, 2));

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "api.url": "$tunnelUrl" } }],
      },
    });

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.existing).toBe("keep");
    expect(data.api.version).toBe(2);
    expect(data.api.url).toBe("https://abc.trycloudflare.com");
  });
});

// ── restoreFromBackup (env) ────────────────────────────────────────────

describe("restoreFromBackup (env)", () => {
  afterEach(cleanup);

  it("restores original values", async () => {
    writeFileSync(TEST_ENV_FILE, "PUBLIC_API_URL=https://abc.trycloudflare.com\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "PUBLIC_API_URL", originalValue: "http://localhost:3000", fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("PUBLIC_API_URL=http://localhost:3000");
    expect(content).not.toContain("trycloudflare");
  });

  it("removes variables that were added by porterman", async () => {
    writeFileSync(TEST_ENV_FILE, "NEW_VAR=https://abc.trycloudflare.com\nEXISTING=keep\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "NEW_VAR", originalValue: null, fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).not.toContain("NEW_VAR");
    expect(content).toContain("EXISTING=keep");
  });

  it("deletes files created by porterman", async () => {
    writeFileSync(TEST_ENV_FILE, "FOO=https://abc.trycloudflare.com\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [TEST_ENV_FILE],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "FOO", originalValue: null, fileCreated: true },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);
    expect(existsSync(TEST_ENV_FILE)).toBe(false);
  });

  it("deletes the backup file after restore", async () => {
    writeFileSync(TEST_ENV_FILE, "FOO=tunnel\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "FOO", originalValue: "original", fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    expect(existsSync(TEST_BACKUP_FILE)).toBe(true);

    await restoreFromBackup("test-cfg", manifest);
    expect(existsSync(TEST_BACKUP_FILE)).toBe(false);
  });

  it("handles multiple entries for same env file", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=https://abc.trycloudflare.com\nNEW_VAR=val\nEXISTING=keep\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "API_URL", originalValue: "http://localhost:3000", fileCreated: false },
        { file: TEST_ENV_FILE, fileType: "env", variable: "NEW_VAR", originalValue: null, fileCreated: false },
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

// ── restoreFromBackup (json) ───────────────────────────────────────────

describe("restoreFromBackup (json)", () => {
  afterEach(cleanup);

  it("restores original JSON values at dot-notated paths", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ api: { url: "https://abc.trycloudflare.com" } }, null, 2) + "\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_JSON_FILE, fileType: "json", variable: "api.url", originalValue: "http://localhost:3000", fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.api.url).toBe("http://localhost:3000");
  });

  it("removes added JSON keys and leaves empty parent objects", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ reverb: { host: "abc.trycloudflare.com" } }, null, 2) + "\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_JSON_FILE, fileType: "json", variable: "reverb.host", originalValue: null, fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.reverb.host).toBeUndefined();
    expect(data.reverb).toEqual({});
  });

  it("deletes JSON files created by porterman", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ api: { url: "https://abc.trycloudflare.com" } }) + "\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [TEST_JSON_FILE],
      entries: [
        { file: TEST_JSON_FILE, fileType: "json", variable: "api.url", originalValue: null, fileCreated: true },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);
    expect(existsSync(TEST_JSON_FILE)).toBe(false);
  });

  it("restores number type from backup", async () => {
    writeFileSync(TEST_JSON_FILE, JSON.stringify({ reverb: { port: 443 } }, null, 2) + "\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_JSON_FILE, fileType: "json", variable: "reverb.port", originalValue: 80, fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);
    await restoreFromBackup("test-cfg", manifest);

    const data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.reverb.port).toBe(80);
    expect(typeof data.reverb.port).toBe("number");
  });
});

// ── Round-trip tests ───────────────────────────────────────────────────

describe("round-trip: apply then restore", () => {
  afterEach(cleanup);

  it("round-trip env: leaves file identical to original after restore", async () => {
    const original = "APP_NAME=MyApp\nDB_HOST=localhost\nPORT=3000\n";
    writeFileSync(TEST_ENV_FILE, original);

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { APP_URL: "$tunnelUrl", PORT: 443 } }],
      },
    });

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));

    let content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("APP_URL=https://abc.trycloudflare.com");
    expect(content).toContain("PORT=443");

    await restoreFromBackup("test-cfg", manifest);

    content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("APP_NAME=MyApp");
    expect(content).toContain("DB_HOST=localhost");
    expect(content).toContain("PORT=3000");
    expect(content).not.toContain("APP_URL");
    expect(content).not.toContain("trycloudflare");
    expect(content).not.toContain("443");
  });

  it("round-trip json: leaves file identical to original after restore", async () => {
    const original = { api: { url: "http://localhost:3000", version: 2 }, debug: true };
    writeFileSync(TEST_JSON_FILE, JSON.stringify(original, null, 2) + "\n");

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_JSON_FILE, variables: { "api.url": "$tunnelUrl", "reverb.port": 443 } }],
      },
    });

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));

    let data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.api.url).toBe("https://abc.trycloudflare.com");
    expect(data.reverb.port).toBe(443);

    await restoreFromBackup("test-cfg", manifest);

    data = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(data.api.url).toBe("http://localhost:3000");
    expect(data.api.version).toBe(2);
    expect(data.debug).toBe(true);
    expect(data.reverb.port).toBeUndefined();
  });

  it("round-trip: file created by porterman gets deleted", async () => {
    try { await unlink(TEST_ENV_FILE); } catch {}

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { MY_URL: "$tunnelUrl" } }],
      },
    });

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));
    expect(existsSync(TEST_ENV_FILE)).toBe(true);

    await restoreFromBackup("test-cfg", manifest);
    expect(existsSync(TEST_ENV_FILE)).toBe(false);
  });

  it("round-trip: multiple tunnels and same env file", async () => {
    const original = "API_URL=http://localhost:3000\nFRONTEND_URL=http://localhost:5177\n";
    writeFileSync(TEST_ENV_FILE, original);

    const config = makeConfig({
      "3000": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { API_URL: "$tunnelUrl", REVERB_PORT: 443 } }],
      },
      "5177": {
        envFiles: [{ file: TEST_ENV_FILE, variables: { FRONTEND_URL: "$tunnelUrl" } }],
      },
    });

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    await applySettings(config, new Map([
      [3000, "https://abc.trycloudflare.com"],
      [5177, "https://def.trycloudflare.com"],
    ]));

    let content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=https://abc.trycloudflare.com");
    expect(content).toContain("REVERB_PORT=443");
    expect(content).toContain("FRONTEND_URL=https://def.trycloudflare.com");

    await restoreFromBackup("test-cfg", manifest);

    content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=http://localhost:3000");
    expect(content).toContain("FRONTEND_URL=http://localhost:5177");
    expect(content).not.toContain("REVERB_PORT");
    expect(content).not.toContain("trycloudflare");
  });

  it("round-trip: mixed env and json files", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=http://localhost:3000\n");
    const jsonOriginal = { reverb: { host: "localhost", port: 6001 } };
    writeFileSync(TEST_JSON_FILE, JSON.stringify(jsonOriginal, null, 2) + "\n");

    const config = makeConfig({
      "3000": {
        envFiles: [
          { file: TEST_ENV_FILE, variables: { API_URL: "$tunnelUrl", HOSTNAME: "$tunnelHostname" } },
          { file: TEST_JSON_FILE, variables: { "reverb.host": "$tunnelHostname", "reverb.port": 443 } },
        ],
      },
    });

    const manifest = createBackup(config);
    writeBackupFile("test-cfg", manifest);

    await applySettings(config, new Map([[3000, "https://abc.trycloudflare.com"]]));

    let envContent = await readFile(TEST_ENV_FILE, "utf-8");
    expect(envContent).toContain("API_URL=https://abc.trycloudflare.com");
    expect(envContent).toContain("HOSTNAME=abc.trycloudflare.com");

    let jsonData = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(jsonData.reverb.host).toBe("abc.trycloudflare.com");
    expect(jsonData.reverb.port).toBe(443);

    await restoreFromBackup("test-cfg", manifest);

    envContent = await readFile(TEST_ENV_FILE, "utf-8");
    expect(envContent).toContain("API_URL=http://localhost:3000");
    expect(envContent).not.toContain("HOSTNAME");

    jsonData = JSON.parse(await readFile(TEST_JSON_FILE, "utf-8"));
    expect(jsonData.reverb.host).toBe("localhost");
    expect(jsonData.reverb.port).toBe(6001);
  });
});

// ── Crash recovery ─────────────────────────────────────────────────────

describe("crash recovery", () => {
  afterEach(cleanup);

  it("backup file exists on startup → restore then proceed", async () => {
    writeFileSync(TEST_ENV_FILE, "API_URL=https://old-tunnel.trycloudflare.com\nADDED_VAR=some-value\n");

    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      createdFiles: [],
      entries: [
        { file: TEST_ENV_FILE, fileType: "env", variable: "API_URL", originalValue: "http://localhost:3000", fileCreated: false },
        { file: TEST_ENV_FILE, fileType: "env", variable: "ADDED_VAR", originalValue: null, fileCreated: false },
      ],
    };

    writeBackupFile("test-cfg", manifest);

    const existingBackup = readBackupFile("test-cfg");
    expect(existingBackup).not.toBeNull();

    await restoreFromBackup("test-cfg", existingBackup!);

    const content = await readFile(TEST_ENV_FILE, "utf-8");
    expect(content).toContain("API_URL=http://localhost:3000");
    expect(content).not.toContain("ADDED_VAR");
    expect(content).not.toContain("trycloudflare");
    expect(existsSync(TEST_BACKUP_FILE)).toBe(false);
  });
});
