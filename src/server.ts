import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext, type SecureContext } from "node:tls";
import { getDashedIp, detectPublicIp } from "./ip.js";
import { getCertificate, handleAcmeChallenge, type CertResult } from "./certs.js";
import { createProxyEngine, type ProxyRoute } from "./proxy.js";
import { makeHostname, isPortAvailable, isValidPort, parsePortFromHost } from "./utils.js";
import { writePidFile, paths } from "./config.js";
import { logger, setVerbose } from "./logger.js";

export interface ServerOptions {
  ports?: number[];
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
  dashedIp: string;
  publicIp: string;
}

export async function startServer(options: ServerOptions): Promise<PortermanServer> {
  const {
    ports = [],
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

  // Validate explicit ports if provided
  for (const port of ports) {
    if (!isValidPort(port)) {
      throw new Error(`Invalid port number: ${port}`);
    }
  }

  if (name && ports.length > 1) {
    throw new Error("--name can only be used with a single port");
  }

  // Dynamic mode: no explicit ports means proxy ANY port from hostname
  const isDynamic = ports.length === 0;

  // Detect public IP
  logger.info("Detecting public IP...");
  const publicIp = host ?? (await detectPublicIp());
  const dashedIp = await getDashedIp(host);
  logger.info(`Public IP: ${publicIp}`);

  // Generate hostnames for explicit ports
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

  // Create proxy engine — dynamic mode if no explicit ports
  const proxyEngine = createProxyEngine({
    timeout,
    routes,
    nameMap,
    dynamic: isDynamic,
  });

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

  // HTTP request handler — serves ACME challenges, redirects, or proxies
  function httpRequestHandler(req: IncomingMessage, res: ServerResponse): void {
    // ACME challenges ALWAYS take priority (needed for cert provisioning)
    if (req.url) {
      const challengeResponse = handleAcmeChallenge(req.url);
      if (challengeResponse) {
        logger.verbose(`ACME challenge response for ${req.url}`);
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

  // ─── START HTTP SERVER FIRST ───
  // This MUST happen before certificate provisioning, because Let's Encrypt
  // HTTP-01 challenges require port 80 to be reachable during validation.
  const httpServer = createHttpServer(httpRequestHandler);

  if (noSsl) {
    httpServer.on("upgrade", (req, socket, head) => {
      proxyEngine.handleUpgrade(req, socket, head);
    });
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(httpPort, "0.0.0.0", () => resolve());
    httpServer.once("error", reject);
  });

  logger.verbose(`HTTP server listening on 0.0.0.0:${httpPort}`);

  // ─── NOW PROVISION CERTIFICATES (HTTP server is up for ACME challenges) ───
  let httpsServer: ReturnType<typeof createHttpsServer> | null = null;
  const certCache = new Map<string, CertResult>();
  const certPending = new Map<string, Promise<CertResult>>();

  async function getOrProvisionCert(hostname: string): Promise<CertResult> {
    if (certCache.has(hostname)) {
      return certCache.get(hostname)!;
    }

    if (certPending.has(hostname)) {
      return certPending.get(hostname)!;
    }

    const promise = getCertificate(hostname, { staging }).then((cert) => {
      certCache.set(hostname, cert);
      certPending.delete(hostname);
      return cert;
    }).catch((err) => {
      certPending.delete(hostname);
      throw err;
    });

    certPending.set(hostname, promise);
    return promise;
  }

  if (!noSsl) {
    // Pre-obtain certificates for explicitly listed hostnames
    if (routes.length > 0) {
      logger.info("Obtaining SSL certificates...");
      for (const route of routes) {
        const cert = await getOrProvisionCert(route.hostname);
        if (cert.selfSigned) {
          logger.warn(
            `Using self-signed certificate for ${route.hostname} (browsers will show a warning)`
          );
        }
      }
    }

    // Default cert: use first cached or generate one for dynamic mode
    let defaultCert: CertResult;
    if (certCache.size > 0) {
      defaultCert = certCache.values().next().value!;
    } else {
      const defaultHostname = `porterman-${dashedIp}.sslip.io`;
      logger.info("Obtaining default SSL certificate...");
      defaultCert = await getCertificate(defaultHostname, { staging });
      certCache.set(defaultHostname, defaultCert);
    }

    // SNI callback: dynamically serve correct cert per hostname, provision on-demand
    const sniCallback = (
      servername: string,
      callback: (err: Error | null, ctx?: SecureContext) => void
    ): void => {
      const cached = certCache.get(servername);
      if (cached) {
        callback(null, createSecureContext({ key: cached.key, cert: cached.cert }));
        return;
      }

      getOrProvisionCert(servername)
        .then((cert) => {
          callback(null, createSecureContext({ key: cert.key, cert: cert.cert }));
        })
        .catch((err) => {
          logger.verbose(`SNI cert provision failed for ${servername}: ${err.message}`);
          callback(null, createSecureContext({ key: defaultCert.key, cert: defaultCert.cert }));
        });
    };

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

    httpsServer.on("upgrade", (req, socket, head) => {
      proxyEngine.handleUpgrade(req, socket, head);
    });

    await new Promise<void>((resolve, reject) => {
      httpsServer!.listen(httpsPort, "0.0.0.0", () => resolve());
      httpsServer!.once("error", reject);
    });

    logger.verbose(`HTTPS server listening on 0.0.0.0:${httpsPort}`);
  }

  // Write PID file
  await writePidFile(process.pid);

  // Build URL map for explicit ports
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

  if (isDynamic) {
    const protocol = noSsl ? "http" : "https";
    const portSuffix =
      (!noSsl && httpsPort !== 443)
        ? `:${httpsPort}`
        : (noSsl && httpPort !== 80)
          ? `:${httpPort}`
          : "";
    console.log(`  Any port is now accessible via:`);
    console.log(`  ${protocol}://{port}-${dashedIp}.sslip.io${portSuffix}`);
    logger.blank();
    console.log(`  Examples:`);
    for (const examplePort of [3000, 5173, 8080]) {
      const exUrl = `${protocol}://${examplePort}-${dashedIp}.sslip.io${portSuffix}`;
      logger.link(`http://localhost:${examplePort}`, exUrl);
    }
  } else {
    for (const route of routes) {
      const url = urls.get(route.targetPort)!;
      logger.link(`http://localhost:${route.targetPort}`, url);
    }
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

    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.pidFile);
    } catch {}

    logger.success("Stopped");
  }

  return { close, urls, dashedIp, publicIp };
}
