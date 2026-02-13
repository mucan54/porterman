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

// Mock env module
vi.mock("../src/env.js", () => ({
  writeEnvFile: vi.fn(async (_mappings: Map<string, string>, _path?: string) => "/mock/.env.porterman"),
  cleanEnvFile: vi.fn(async () => {}),
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
    await startServer({ ports: [3000, 3000, 3000] });

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

  it("accepts PortMapping objects with env variables", async () => {
    const { startServer } = await import("../src/server.js");
    const server = await startServer({
      ports: [
        { port: 3000, envVar: "FRONTEND_URL" },
        { port: 8080, envVar: "API_URL" },
      ],
    });

    expect(server.urls.size).toBe(2);
    expect(server.envVars.size).toBe(2);
    expect(server.envVars.get("FRONTEND_URL")).toBe("https://mock-3000.trycloudflare.com");
    expect(server.envVars.get("API_URL")).toBe("https://mock-8080.trycloudflare.com");
  });

  it("writes env file when env vars are specified", async () => {
    const { writeEnvFile } = await import("../src/env.js");
    const { startServer } = await import("../src/server.js");

    await startServer({
      ports: [{ port: 3000, envVar: "FRONTEND_URL" }],
    });

    expect(writeEnvFile).toHaveBeenCalledTimes(1);
  });

  it("does not write env file when no env vars are specified", async () => {
    const { writeEnvFile } = await import("../src/env.js");
    const { startServer } = await import("../src/server.js");

    await startServer({ ports: [3000] });

    expect(writeEnvFile).not.toHaveBeenCalled();
  });

  it("mixes plain ports and port mappings", async () => {
    const { startServer } = await import("../src/server.js");
    const server = await startServer({
      ports: [
        3000,
        { port: 8080, envVar: "API_URL" },
      ],
    });

    expect(server.urls.size).toBe(2);
    expect(server.envVars.size).toBe(1);
    expect(server.envVars.get("API_URL")).toBe("https://mock-8080.trycloudflare.com");
  });

  it("cleans env file on close when env vars were used", async () => {
    const { cleanEnvFile } = await import("../src/env.js");
    const { startServer } = await import("../src/server.js");

    const server = await startServer({
      ports: [{ port: 3000, envVar: "MY_URL" }],
    });

    await server.close();

    expect(cleanEnvFile).toHaveBeenCalled();
  });
});
