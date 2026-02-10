import { describe, it, expect, afterAll } from "vitest";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createProxyEngine, type ProxyRoute } from "../src/proxy.js";

// Start a simple target server for proxy tests
const TARGET_PORT = 19876;
let targetServer: ReturnType<typeof createServer>;

const startTarget = () =>
  new Promise<void>((resolve) => {
    targetServer = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
        })
      );
    });
    targetServer.listen(TARGET_PORT, resolve);
  });

afterAll(() => {
  return new Promise<void>((resolve) => {
    if (targetServer) targetServer.close(() => resolve());
    else resolve();
  });
});

function makeRequest(
  port: number,
  path: string,
  hostHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createProxyEngine", () => {
  it("creates a proxy engine with routes", () => {
    const routes: ProxyRoute[] = [
      { hostname: "3000-1-2-3-4.sslip.io", targetPort: 3000 },
    ];
    const engine = createProxyEngine({ timeout: 30, routes });
    expect(engine).toHaveProperty("handleRequest");
    expect(engine).toHaveProperty("handleUpgrade");
    expect(engine).toHaveProperty("close");
    engine.close();
  });

  it("proxies requests to the target server", async () => {
    await startTarget();

    const routes: ProxyRoute[] = [
      {
        hostname: `${TARGET_PORT}-1-2-3-4.sslip.io`,
        targetPort: TARGET_PORT,
      },
    ];
    const engine = createProxyEngine({ timeout: 5, routes });

    const proxyServer = createServer((req, res) => {
      engine.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    const addr = proxyServer.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const response = await makeRequest(
      addr.port,
      "/test",
      `${TARGET_PORT}-1-2-3-4.sslip.io`
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.url).toBe("/test");

    proxyServer.close();
    engine.close();
  });

  it("returns 404 for unknown hosts", async () => {
    const routes: ProxyRoute[] = [
      { hostname: "3000-1-2-3-4.sslip.io", targetPort: 3000 },
    ];
    const engine = createProxyEngine({ timeout: 5, routes });

    const proxyServer = createServer((req, res) => {
      engine.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    const addr = proxyServer.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    const response = await makeRequest(
      addr.port,
      "/",
      "unknown-host.example.com"
    );

    expect(response.status).toBe(404);

    proxyServer.close();
    engine.close();
  });

  it("dynamic mode proxies any port from hostname", async () => {
    // Ensure target is running
    if (!targetServer?.listening) await startTarget();

    const engine = createProxyEngine({ timeout: 5, dynamic: true });

    const proxyServer = createServer((req, res) => {
      engine.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => proxyServer.listen(0, resolve));
    const addr = proxyServer.address();
    if (!addr || typeof addr === "string") throw new Error("no address");

    // Dynamic mode should route based on port parsed from hostname
    const response = await makeRequest(
      addr.port,
      "/dynamic-test",
      `${TARGET_PORT}-1-2-3-4.sslip.io`
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.url).toBe("/dynamic-test");

    proxyServer.close();
    engine.close();
  });

  it("dynamic mode resolves port from any hostname", () => {
    const engine = createProxyEngine({ timeout: 5, dynamic: true });
    expect(engine.resolveTargetPort("8080-10-20-30-40.sslip.io")).toBe(8080);
    expect(engine.resolveTargetPort("3000-10-20-30-40.sslip.io")).toBe(3000);
    expect(engine.resolveTargetPort("5173-10-20-30-40.sslip.io")).toBe(5173);
    expect(engine.resolveTargetPort("unknown.example.com")).toBeNull();
    engine.close();
  });
});
