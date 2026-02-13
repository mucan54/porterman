import { describe, it, expect, afterEach } from "vitest";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  parsePortArg,
  writeEnvFile,
  cleanEnvFile,
  formatExports,
  MARKER_START,
  MARKER_END,
} from "../src/env.js";

describe("parsePortArg", () => {
  it("parses plain port number", () => {
    const result = parsePortArg("3000");
    expect(result.port).toBe(3000);
    expect(result.envVar).toBeUndefined();
  });

  it("parses port with env variable", () => {
    const result = parsePortArg("3000:FRONTEND_URL");
    expect(result.port).toBe(3000);
    expect(result.envVar).toBe("FRONTEND_URL");
  });

  it("parses port with lowercase env variable", () => {
    const result = parsePortArg("8080:api_url");
    expect(result.port).toBe(8080);
    expect(result.envVar).toBe("api_url");
  });

  it("parses port with underscore-prefixed env variable", () => {
    const result = parsePortArg("5173:_MY_VAR");
    expect(result.port).toBe(5173);
    expect(result.envVar).toBe("_MY_VAR");
  });

  it("throws on invalid port", () => {
    expect(() => parsePortArg("0")).toThrow("Invalid port");
    expect(() => parsePortArg("99999")).toThrow("Invalid port");
    expect(() => parsePortArg("abc")).toThrow("Invalid port");
  });

  it("throws on invalid env variable name", () => {
    expect(() => parsePortArg("3000:123BAD")).toThrow("Invalid env variable name");
    expect(() => parsePortArg("3000:MY-VAR")).toThrow("Invalid env variable name");
    expect(() => parsePortArg("3000:my var")).toThrow("Invalid env variable name");
  });

  it("handles empty env var after colon as no env var", () => {
    const result = parsePortArg("3000:");
    expect(result.port).toBe(3000);
    expect(result.envVar).toBeUndefined();
  });
});

describe("writeEnvFile", () => {
  const testFile = resolve(".env.porterman.test");

  afterEach(async () => {
    try {
      await unlink(testFile);
    } catch {}
  });

  it("creates a new file with marker comments", async () => {
    const mappings = new Map([
      ["FRONTEND_URL", "https://abc.trycloudflare.com"],
      ["API_URL", "https://def.trycloudflare.com"],
    ]);

    const path = await writeEnvFile(mappings, testFile);
    expect(path).toBe(testFile);

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain(MARKER_START);
    expect(content).toContain(MARKER_END);
    expect(content).toContain("FRONTEND_URL=https://abc.trycloudflare.com");
    expect(content).toContain("API_URL=https://def.trycloudflare.com");
  });

  it("prepends managed block to existing file content", async () => {
    // Pre-create a file with existing content
    const existing = "APP_NAME=MyApp\nAPP_ENV=local\n";
    await writeFile(testFile, existing);

    const mappings = new Map([
      ["TUNNEL_URL", "https://xyz.trycloudflare.com"],
    ]);

    await writeEnvFile(mappings, testFile);

    const content = await readFile(testFile, "utf-8");
    // Existing content should be preserved
    expect(content).toContain("APP_NAME=MyApp");
    expect(content).toContain("APP_ENV=local");
    // Managed block should be prepended
    expect(content).toContain(MARKER_START);
    expect(content).toContain("TUNNEL_URL=https://xyz.trycloudflare.com");
    expect(content).toContain(MARKER_END);
    // Managed block should come BEFORE existing content
    const markerIdx = content.indexOf(MARKER_START);
    const appNameIdx = content.indexOf("APP_NAME=MyApp");
    expect(markerIdx).toBeLessThan(appNameIdx);
  });

  it("replaces existing managed block on re-run", async () => {
    // First write
    const mappings1 = new Map([
      ["OLD_URL", "https://old.trycloudflare.com"],
    ]);
    await writeEnvFile(mappings1, testFile);

    // Second write with different mappings
    const mappings2 = new Map([
      ["NEW_URL", "https://new.trycloudflare.com"],
    ]);
    await writeEnvFile(mappings2, testFile);

    const content = await readFile(testFile, "utf-8");
    // Old mapping should be gone
    expect(content).not.toContain("OLD_URL");
    // New mapping should be present
    expect(content).toContain("NEW_URL=https://new.trycloudflare.com");
    // Should have exactly one start and one end marker
    const startCount = content.split(MARKER_START).length - 1;
    const endCount = content.split(MARKER_END).length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("replaces managed block while preserving surrounding content", async () => {
    // Pre-create a file with existing content and a managed block
    const existing = [
      "APP_NAME=MyApp",
      "",
      MARKER_START,
      "OLD_VAR=https://old.trycloudflare.com",
      MARKER_END,
      "",
      "DB_HOST=localhost",
      "",
    ].join("\n");
    await writeFile(testFile, existing);

    const mappings = new Map([
      ["NEW_VAR", "https://new.trycloudflare.com"],
    ]);
    await writeEnvFile(mappings, testFile);

    const content = await readFile(testFile, "utf-8");
    // Surrounding content preserved
    expect(content).toContain("APP_NAME=MyApp");
    expect(content).toContain("DB_HOST=localhost");
    // Old managed content replaced
    expect(content).not.toContain("OLD_VAR");
    // New managed content present
    expect(content).toContain("NEW_VAR=https://new.trycloudflare.com");
  });

  it("returns the resolved file path", async () => {
    const mappings = new Map([["TEST", "value"]]);
    const path = await writeEnvFile(mappings, testFile);
    expect(path).toBe(testFile);
  });
});

describe("cleanEnvFile", () => {
  const testFile = resolve(".env.porterman.test");

  afterEach(async () => {
    try {
      await unlink(testFile);
    } catch {}
  });

  it("removes managed block from the top of a user-provided file", async () => {
    // Simulate the typical case: block prepended at top
    const content = [
      MARKER_START,
      "TUNNEL_URL=https://abc.trycloudflare.com",
      MARKER_END,
      "",
      "APP_NAME=MyApp",
      "APP_ENV=local",
      "DB_HOST=localhost",
      "",
    ].join("\n");
    await writeFile(testFile, content);

    await cleanEnvFile(testFile);

    const result = await readFile(testFile, "utf-8");
    // Managed block should be removed
    expect(result).not.toContain(MARKER_START);
    expect(result).not.toContain(MARKER_END);
    expect(result).not.toContain("TUNNEL_URL");
    // Remaining content preserved
    expect(result).toContain("APP_NAME=MyApp");
    expect(result).toContain("APP_ENV=local");
    expect(result).toContain("DB_HOST=localhost");
  });

  it("removes managed block from the middle of a file", async () => {
    // Edge case: block was placed in the middle (e.g. manual edit)
    const content = [
      "APP_NAME=MyApp",
      "",
      MARKER_START,
      "TUNNEL_URL=https://abc.trycloudflare.com",
      MARKER_END,
      "",
      "DB_HOST=localhost",
      "",
    ].join("\n");
    await writeFile(testFile, content);

    await cleanEnvFile(testFile);

    const result = await readFile(testFile, "utf-8");
    expect(result).not.toContain(MARKER_START);
    expect(result).not.toContain("TUNNEL_URL");
    expect(result).toContain("APP_NAME=MyApp");
    expect(result).toContain("DB_HOST=localhost");
  });

  it("leaves file unchanged if no managed block exists", async () => {
    const original = "APP_NAME=MyApp\nDB_HOST=localhost\n";
    await writeFile(testFile, original);

    await cleanEnvFile(testFile);

    const result = await readFile(testFile, "utf-8");
    expect(result).toBe(original);
  });

  it("does not throw if file does not exist", async () => {
    await expect(
      cleanEnvFile("/tmp/nonexistent-porterman-test")
    ).resolves.toBeUndefined();
  });

  it("works with writeEnvFile round-trip on existing file", async () => {
    // Simulate a real workflow: existing .env, add managed block, then clean
    const original = "APP_KEY=base64:abc123\nDB_HOST=127.0.0.1\n";
    await writeFile(testFile, original);

    // Write porterman mappings
    const mappings = new Map([
      ["FRONTEND_URL", "https://abc.trycloudflare.com"],
    ]);
    await writeEnvFile(mappings, testFile);

    // Verify managed block was added
    let content = await readFile(testFile, "utf-8");
    expect(content).toContain(MARKER_START);
    expect(content).toContain("FRONTEND_URL=https://abc.trycloudflare.com");

    // Clean up
    await cleanEnvFile(testFile);

    // Verify only managed block is removed
    content = await readFile(testFile, "utf-8");
    expect(content).not.toContain(MARKER_START);
    expect(content).not.toContain("FRONTEND_URL");
    expect(content).toContain("APP_KEY=base64:abc123");
    expect(content).toContain("DB_HOST=127.0.0.1");
  });
});

describe("formatExports", () => {
  it("formats mappings as shell export statements", () => {
    const mappings = new Map([
      ["FRONTEND_URL", "https://abc.trycloudflare.com"],
      ["API_URL", "https://def.trycloudflare.com"],
    ]);

    const result = formatExports(mappings);
    expect(result).toBe(
      "export FRONTEND_URL=https://abc.trycloudflare.com\n" +
        "export API_URL=https://def.trycloudflare.com"
    );
  });

  it("returns empty string for empty map", () => {
    expect(formatExports(new Map())).toBe("");
  });
});
