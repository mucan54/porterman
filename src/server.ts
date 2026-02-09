import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext, type SecureContext } from "node:tls";
import { getDashedIp, detectPublicIp } from "./ip.js";
import { getCertificate, handleAcmeChallenge, type CertResult } from "./certs.js";
import { createProxyEngine, type ProxyRoute } from "./proxy.js";
import { makeHostname, isPortAvailable, isValidPort } from "./utils.js";
import { writePidFile, paths } from "./config.js";
import { logger, setVerbose } from "./logger.js";
import { readFileSync } from "node:fs";

export interface ServerOptions {
  ports: number[];
  name?: string;
  noSsl?: boolean;
  verbose?: boolean;
  timeout?: number;
  host?: string;
  staging?: boolean;
  httpPort?: number;
  httpsPort?: number;
  auth?: string;
  ipAllow?: string[];
}

export interface PortermanServer {
  close(): Promise<void>;
  urls: Map<number, string>;
}

export async function startServer(options: ServerOptions): Promise<PortermanServer> {
  const {
    ports,
    name,
    noSsl = false,
    verbose = false,
    timeout = 30,
    host,
    staging = false,
    httpPort = 80,
    httpsPort = 443,
    auth,
    ipAllow,
  } = options;

  setVerbose(verbose);

  // Validate ports
  for (const port of ports) {
    if (!isValidPort(port)) {
      throw new Error(`Invalid port number: ${port}`);
    }
  }

  if (name && ports.length > 1) {
    throw new Error("--name can only be used with a single port");
  }

  // Detect public IP
  logger.info("Detecting public IP...");
  const publicIp = host ?? (await detectPublicIp());
  const dashedIp = await getDashedIp(host);
  logger.info(`Public IP: ${publicIp}`);

  // Generate hostnames
  const routes: ProxyRoute[] = ports.map((port) => {
    const prefix = name && ports.length === 1 ? name : String(port);
    return {
      hostname: makeHostname(prefix, dashedIp),
      targetPort: port,
      name: name && ports.length === 1 ? name : undefined,
    };
  });

  // Build name map if using custom names
  const nameMap = new Map<string, number>();
  if (name && ports.length === 1) {
    nameMap.set(name, ports[0]);
  }

  // Check port availability
  if (!noSsl) {
    if (!(await isPortAvailable(httpsPort))) {
      throw new Error(
        `Port ${httpsPort} is already in use. Try:\n` +
          `  - Run with sudo if port < 1024\n` +
          `  - Use --https-port <port> to specify a different port\n` +
          `  - Stop the process using port ${httpsPort}`
      );
    }
  }

  if (!(await isPortAvailable(httpPort))) {
    throw new Error(
      `Port ${httpPort} is already in use. Try:\n` +
        `  - Run with sudo if port < 1024\n` +
        `  - Use --http-port <port> to specify a different port\n` +
        `  - Stop the process using port ${httpPort}`
    );
  }

  // Create proxy engine
  const proxyEngine = createProxyEngine({ timeout, routes, nameMap });

  // Parse basic auth credentials if provided
  let authCredentials: { user: string; pass: string } | null = null;
  if (auth) {
    const [user, pass] = auth.split(":");
    if (!user || !pass) {
      throw new Error("--auth must be in format user:pass");
    }
    authCredentials = { user, pass };
  }

  // Parse allowed IPs
  const allowedIps = ipAllow ? new Set(ipAllow) : null;

  // Middleware: auth check
  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!authCredentials) return true;

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Porterman"',
        "Content-Type": "text/plain",
      });
      res.end("Authentication required");
      return false;
    }

    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [user, pass] = decoded.split(":");
    if (user !== authCredentials.user || pass !== authCredentials.pass) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return false;
    }

    return true;
  }

  // Middleware: IP allow check
  function checkIpAllow(req: IncomingMessage, res: ServerResponse): boolean {
    if (!allowedIps) return true;

    const clientIp =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "";

    // Normalize IPv6-mapped IPv4
    const normalizedIp = clientIp.replace(/^::ffff:/, "");

    if (!allowedIps.has(normalizedIp)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: IP not allowed");
      return false;
    }

    return true;
  }

  // HTTP request handler
  function httpRequestHandler(req: IncomingMessage, res: ServerResponse): void {
    // Handle ACME challenges
    if (req.url) {
      const challengeResponse = handleAcmeChallenge(req.url);
      if (challengeResponse) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challengeResponse);
        return;
      }
    }

    if (noSsl) {
      // In no-ssl mode, HTTP server handles proxying
      if (!checkIpAllow(req, res)) return;
      if (!checkAuth(req, res)) return;
      proxyEngine.handleRequest(req, res);
      return;
    }

    // Redirect HTTP to HTTPS
    const host = req.headers.host ?? "";
    const httpsUrl = `https://${host.split(":")[0]}${httpsPort !== 443 ? `:${httpsPort}` : ""}${req.url ?? "/"}`;
    res.writeHead(301, { Location: httpsUrl });
    res.end();
  }

  // Start HTTP server
  const httpServer = createHttpServer(httpRequestHandler);

  // Handle WebSocket upgrades on HTTP server (no-ssl mode)
  if (noSsl) {
    httpServer.on("upgrade", (req, socket, head) => {
      proxyEngine.handleUpgrade(req, socket, head);
    });
  }

  let httpsServer: ReturnType<typeof createHttpsServer> | null = null;
  const certCache = new Map<string, CertResult>();

  if (!noSsl) {
    // Obtain certificates for all hostnames
    logger.info("Obtaining SSL certificates...");

    for (const route of routes) {
      const cert = await getCertificate(route.hostname, { staging });
      certCache.set(route.hostname, cert);
      if (cert.selfSigned) {
        logger.warn(
          `Using self-signed certificate for ${route.hostname} (browsers will show a warning)`
        );
      }
    }

    // SNI callback for multi-cert support
    const sniCallback = (
      servername: string,
      callback: (err: Error | null, ctx?: SecureContext) => void
    ): void => {
      const cert = certCache.get(servername);
      if (cert) {
        const ctx = createSecureContext({
          key: cert.key,
          cert: cert.cert,
        });
        callback(null, ctx);
      } else {
        // Try to find a matching cert
        for (const [hostname, c] of certCache) {
          if (servername.endsWith(hostname.slice(hostname.indexOf(".")))) {
            const ctx = createSecureContext({
              key: c.key,
              cert: c.cert,
            });
            callback(null, ctx);
            return;
          }
        }
        callback(new Error(`No certificate for ${servername}`));
      }
    };

    // Use the first cert as default
    const defaultCert = certCache.values().next().value!;

    httpsServer = createHttpsServer(
      {
        key: defaultCert.key,
        cert: defaultCert.cert,
        SNICallback: sniCallback,
      },
      (req, res) => {
        if (!checkIpAllow(req, res)) return;
        if (!checkAuth(req, res)) return;
        proxyEngine.handleRequest(req, res);
      }
    );

    // Handle WebSocket upgrades on HTTPS
    httpsServer.on("upgrade", (req, socket, head) => {
      proxyEngine.handleUpgrade(req, socket, head);
    });

    // Start HTTPS server
    await new Promise<void>((resolve, reject) => {
      httpsServer!.listen(httpsPort, () => resolve());
      httpsServer!.once("error", reject);
    });

    logger.verbose(`HTTPS server listening on port ${httpsPort}`);
  }

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(httpPort, () => resolve());
    httpServer.once("error", reject);
  });

  logger.verbose(`HTTP server listening on port ${httpPort}`);

  // Write PID file
  await writePidFile(process.pid);

  // Build URL map
  const urls = new Map<number, string>();
  for (const route of routes) {
    const protocol = noSsl ? "http" : "https";
    const portSuffix =
      (!noSsl && httpsPort !== 443)
        ? `:${httpsPort}`
        : (noSsl && httpPort !== 80)
          ? `:${httpPort}`
          : "";
    urls.set(route.targetPort, `${protocol}://${route.hostname}${portSuffix}`);
  }

  // Print ready message
  logger.blank();
  logger.success("Ready!");
  logger.blank();
  for (const route of routes) {
    const url = urls.get(route.targetPort)!;
    logger.link(`http://localhost:${route.targetPort}`, url);
  }
  logger.blank();
  console.log("  Press Ctrl+C to stop");
  logger.blank();

  // Graceful shutdown
  async function close(): Promise<void> {
    logger.info("Shutting down...");
    proxyEngine.close();

    const closePromises: Promise<void>[] = [];

    closePromises.push(
      new Promise<void>((resolve) => httpServer.close(() => resolve()))
    );

    if (httpsServer) {
      closePromises.push(
        new Promise<void>((resolve) => httpsServer!.close(() => resolve()))
      );
    }

    await Promise.all(closePromises);

    // Clean up PID file
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.pidFile);
    } catch {}

    logger.success("Stopped");
  }

  return { close, urls };
}
