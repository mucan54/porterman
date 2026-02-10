import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock tunnel module
vi.mock("../src/tunnel.js", () => ({
  startTunnel: vi.fn(async (port: number) => ({
    url: `https://mock-${port}.trycloudflare.com`,
    port,
    stop: vi.fn(),
  })),
  startTunnels: vi.fn(async (ports: number[]) =>
    ports.map((port) => ({
      url: `https://mock-${port}.trycloudflare.com`,
      port,
      stop: vi.fn(),
    }))
  ),
}));

// Mock config module
vi.mock("../src/config.js", () => ({
  writePidFile: vi.fn(async () => {}),
  paths: { pidFile: "/tmp/test.pid" },
}));

describe("startServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates tunnels for all specified ports", async () => {
    const { startServer } = await import("../src/server.js");
    const server = await startServer({ ports: [3000, 8080] });

    expect(server.urls.size).toBe(2);
    expect(server.urls.get(3000)).toBe("https://mock-3000.trycloudflare.com");
    expect(server.urls.get(8080)).toBe("https://mock-8080.trycloudflare.com");
    expect(server.tunnels).toHaveLength(2);
  });

  it("throws on empty ports array", async () => {
    const { startServer } = await import("../src/server.js");
    await expect(startServer({ ports: [] })).rejects.toThrow(
      "At least one port is required"
    );
  });

  it("throws on invalid port numbers", async () => {
    const { startServer } = await import("../src/server.js");
    await expect(startServer({ ports: [0] })).rejects.toThrow("Invalid port");
    await expect(startServer({ ports: [70000] })).rejects.toThrow("Invalid port");
  });

  it("deduplicates ports", async () => {
    const { startServer } = await import("../src/server.js");
    const { startTunnels } = await import("../src/tunnel.js");
    const server = await startServer({ ports: [3000, 3000, 3000] });

    expect(startTunnels).toHaveBeenCalledWith([3000], expect.any(Object));
  });

  it("close stops all tunnels", async () => {
    const { startServer } = await import("../src/server.js");
    const server = await startServer({ ports: [3000] });

    await server.close();

    for (const tunnel of server.tunnels) {
      expect(tunnel.stop).toHaveBeenCalled();
    }
  });
});
