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
  };
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
