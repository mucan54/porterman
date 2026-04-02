import { describe, it, expect, vi } from "vitest";

// Mock the cloudflared module before importing our tunnel module
vi.mock("cloudflared", () => {
  const { EventEmitter } = require("node:events");

  class MockTunnel extends EventEmitter {
    stop = vi.fn();

    static quick(url?: string) {
      const instance = new MockTunnel();
      // Simulate async URL emission
      setTimeout(() => {
        instance.emit("url", "https://test-abc123.trycloudflare.com");
      }, 10);
      return instance;
    }

    static withToken(token: string) {
      return new MockTunnel();
    }
  }

  return {
    Tunnel: MockTunnel,
    bin: "/tmp/mock-cloudflared-bin",
    install: vi.fn(),
  };
});

describe("parseCloudflaredVersion", () => {
  it("parses standard version output", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    const result = parseCloudflaredVersion(
      "cloudflared version 2025.2.0 (built 2025-02-10-1200 linux/amd64)"
    );
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2025.2.0");
    expect(result!.date.getFullYear()).toBe(2025);
    expect(result!.date.getMonth()).toBe(1); // February = 1
  });

  it("parses bare version string", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    const result = parseCloudflaredVersion("2026.3.0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2026.3.0");
    expect(result!.date.getFullYear()).toBe(2026);
    expect(result!.date.getMonth()).toBe(2); // March = 2
  });

  it("parses single-digit month", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    const result = parseCloudflaredVersion("2024.1.0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2024.1.0");
    expect(result!.date.getMonth()).toBe(0); // January = 0
  });

  it("parses double-digit month", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    const result = parseCloudflaredVersion("2024.12.0");
    expect(result).not.toBeNull();
    expect(result!.version).toBe("2024.12.0");
    expect(result!.date.getMonth()).toBe(11); // December = 11
  });

  it("returns null for invalid input", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    expect(parseCloudflaredVersion("not a version")).toBeNull();
    expect(parseCloudflaredVersion("")).toBeNull();
    expect(parseCloudflaredVersion("abc.def.ghi")).toBeNull();
  });

  it("returns null for out-of-range year", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    expect(parseCloudflaredVersion("1999.1.0")).toBeNull();
  });

  it("returns null for out-of-range month", async () => {
    const { parseCloudflaredVersion } = await import("../src/tunnel.js");
    expect(parseCloudflaredVersion("2025.13.0")).toBeNull();
    expect(parseCloudflaredVersion("2025.0.0")).toBeNull();
  });
});

describe("startTunnel", () => {
  it("resolves with a tunnel instance containing url, port, and stop", async () => {
    const { startTunnel } = await import("../src/tunnel.js");
    const result = await startTunnel(3000);

    expect(result.url).toBe("https://test-abc123.trycloudflare.com");
    expect(result.port).toBe(3000);
    expect(typeof result.stop).toBe("function");
  });

  it("preserves the port number in the result", async () => {
    const { startTunnel } = await import("../src/tunnel.js");
    const result = await startTunnel(8080);

    expect(result.port).toBe(8080);
  });
});

describe("startTunnels", () => {
  it("starts tunnels for multiple ports concurrently", async () => {
    const { startTunnels } = await import("../src/tunnel.js");
    const results = await startTunnels([3000, 8080, 5173]);

    expect(results).toHaveLength(3);
    expect(results[0].port).toBe(3000);
    expect(results[1].port).toBe(8080);
    expect(results[2].port).toBe(5173);
    for (const r of results) {
      expect(r.url).toMatch(/^https:\/\//);
      expect(typeof r.stop).toBe("function");
    }
  });
});
