import httpProxy from "http-proxy";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "./logger.js";
import { parsePortFromHost } from "./utils.js";

export interface ProxyRoute {
  hostname: string;
  targetPort: number;
  name?: string;
}

export interface ProxyOptions {
  timeout: number;
  routes?: ProxyRoute[];
  nameMap?: Map<string, number>; // name → target port
  dynamic?: boolean; // allow any port parsed from hostname
}

const ERROR_502_HTML = (port: number) => `<!DOCTYPE html>
<html>
<head><title>502 Bad Gateway</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; }
  h1 { color: #e74c3c; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>502 Bad Gateway</h1>
  <p>Nothing is running on <code>localhost:${port}</code></p>
  <p>Make sure your application is started and listening on port <strong>${port}</strong>.</p>
  <hr>
  <p><small>Porterman</small></p>
</body>
</html>`;

export function createProxyEngine(options: ProxyOptions) {
  const { timeout, routes = [], nameMap, dynamic = false } = options;

  // Build port lookup: hostname → target port
  const routeMap = new Map<string, number>();
  for (const route of routes) {
    routeMap.set(route.hostname, route.targetPort);
  }

  const proxy = httpProxy.createProxyServer({
    xfwd: true, // sets X-Forwarded-* headers
    ws: true,
    proxyTimeout: timeout * 1000,
    timeout: timeout * 1000,
  });

  proxy.on("error", (err, req, res) => {
    const host = req.headers.host ?? "unknown";
    const targetPort = resolveTargetPort(host);
    logger.verbose(`Proxy error for ${host}: ${err.message}`);

    if (res && "writeHead" in res) {
      const serverRes = res as ServerResponse;
      if (!serverRes.headersSent) {
        serverRes.writeHead(502, { "Content-Type": "text/html" });
        serverRes.end(ERROR_502_HTML(targetPort ?? 0));
      }
    }
  });

  function resolveTargetPort(host: string): number | null {
    // Normalize: remove port suffix
    const hostname = host.split(":")[0];

    // Direct hostname match (pre-registered routes)
    if (routeMap.has(hostname)) {
      return routeMap.get(hostname)!;
    }

    // Check name map
    if (nameMap) {
      const prefix = hostname.split("-")[0];
      if (nameMap.has(prefix)) {
        return nameMap.get(prefix)!;
      }
    }

    // Try parsing port from hostname dynamically
    const port = parsePortFromHost(host);
    if (port !== null) {
      // In dynamic mode, accept any valid port
      if (dynamic) return port;
      // In static mode, only accept ports that are in our routes
      for (const route of routes) {
        if (route.targetPort === port) return port;
      }
    }

    return null;
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const host = req.headers.host;
    if (!host) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request: No Host header");
      return false;
    }

    const targetPort = resolveTargetPort(host);
    if (targetPort === null) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Not Found: No route configured for ${host}`);
      return false;
    }

    logger.verbose(`Proxying ${req.method} ${host}${req.url} → localhost:${targetPort}`);

    proxy.web(req, res, {
      target: `http://127.0.0.1:${targetPort}`,
    });

    return true;
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer
  ): boolean {
    const host = req.headers.host;
    if (!host) return false;

    const targetPort = resolveTargetPort(host);
    if (targetPort === null) return false;

    logger.verbose(`WebSocket upgrade ${host} → localhost:${targetPort}`);

    proxy.ws(req, socket, head, {
      target: `http://127.0.0.1:${targetPort}`,
    });

    return true;
  }

  function close(): void {
    proxy.close();
  }

  return { handleRequest, handleUpgrade, close, resolveTargetPort };
}
