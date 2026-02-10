import cac from "cac";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "./server.js";
import { cleanCerts, getCertificate } from "./certs.js";
import { readPidFile, pidFileExists } from "./config.js";
import { logger } from "./logger.js";

// Read version from package.json
let version = "1.0.0";
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // Try multiple paths since we might be in dist/ or src/
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, rel), "utf-8"));
      version = pkg.version;
      break;
    } catch {}
  }
} catch {}

const cli = cac("porterman");

// expose command
cli
  .command("expose [...ports]", "Expose one or more local ports over HTTPS")
  .option("-n, --name <name>", "Custom subdomain prefix (single port only)")
  .option("--no-ssl", "HTTP only mode (skip SSL)")
  .option("-v, --verbose", "Log all requests")
  .option("--timeout <seconds>", "Proxy timeout in seconds", { default: 30 })
  .option("--host <ip>", "Override auto-detected public IP")
  .option("--staging", "Use Let's Encrypt staging environment")
  .option("--http-port <port>", "Custom HTTP port", { default: 80 })
  .option("--https-port <port>", "Custom HTTPS port", { default: 443 })
  .option("--auth <user:pass>", "Enable basic auth on exposed ports")
  .option("--ip-allow <ips>", "Comma-separated list of allowed IPs")
  .action(async (portsRaw: string[], options) => {
    logger.banner(version);
    logger.blank();

    // No ports = dynamic mode (proxy any port from hostname)
    const ports = (portsRaw ?? []).map((p) => {
      const num = parseInt(p, 10);
      if (isNaN(num) || num < 1 || num > 65535) {
        logger.error(`Invalid port: ${p}`);
        process.exit(1);
      }
      return num;
    });

    if (ports.length === 0) {
      logger.info("Dynamic mode: all ports will be proxied automatically");
    }

    const ipAllow = options.ipAllow
      ? (options.ipAllow as string).split(",").map((ip: string) => ip.trim())
      : undefined;

    let server: Awaited<ReturnType<typeof startServer>> | null = null;

    try {
      server = await startServer({
        ports,
        name: options.name,
        noSsl: options.ssl === false,
        verbose: options.verbose,
        timeout: Number(options.timeout),
        host: options.host,
        staging: options.staging,
        httpPort: Number(options.httpPort),
        httpsPort: Number(options.httpsPort),
        auth: options.auth,
        ipAllow,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Handle graceful shutdown
    const shutdown = async () => {
      if (server) {
        await server.close();
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

// status command
cli.command("status", "Show running Porterman instance info").action(async () => {
  if (!pidFileExists()) {
    logger.info("No Porterman instance is running.");
    return;
  }

  const pid = await readPidFile();
  if (pid === null) {
    logger.info("No Porterman instance is running.");
    return;
  }

  // Check if process is actually running
  try {
    process.kill(pid, 0);
    logger.success(`Porterman is running (PID: ${pid})`);
  } catch {
    logger.info("No Porterman instance is running (stale PID file).");
  }
});

// stop command
cli.command("stop", "Stop running Porterman instance").action(async () => {
  if (!pidFileExists()) {
    logger.info("No Porterman instance is running.");
    return;
  }

  const pid = await readPidFile();
  if (pid === null) {
    logger.info("No Porterman instance is running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    logger.success(`Porterman stopped (PID: ${pid})`);
  } catch {
    logger.info("No Porterman instance is running (stale PID file).");
  }
});

// certs command
cli
  .command("certs", "Manage SSL certificates")
  .option("--renew", "Force certificate renewal")
  .option("--clean", "Remove all cached certificates")
  .action(async (options) => {
    if (options.clean) {
      await cleanCerts();
      return;
    }

    if (options.renew) {
      logger.info("Certificate renewal is done automatically when using 'expose'.");
      logger.info("Use 'porterman expose <port> --staging' to test with Let's Encrypt staging.");
      return;
    }

    logger.info("Use --renew to force renewal or --clean to remove all cached certs.");
  });

// Default command (show help)
cli.command("", "Show help").action(() => {
  cli.outputHelp();
});

cli.help();
cli.version(version);

cli.parse();
