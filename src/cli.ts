import cac from "cac";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer, type PortMapping } from "./server.js";
import { parsePortArg, formatExports } from "./env.js";
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
  .command("expose [...ports]", "Expose local ports via Cloudflare Tunnel")
  .option("-v, --verbose", "Log all tunnel activity")
  .option("--env-file <path>", "Path to write env file (default: .env.porterman)")
  .option("--eval", "Output export statements for shell eval")
  .action(async (portsRaw: string[], options) => {
    const isEvalMode = options.eval === true;

    if (!isEvalMode) {
      logger.banner(version);
      logger.blank();
    }

    if (!portsRaw || portsRaw.length === 0) {
      logger.error("At least one port is required");
      logger.info("Usage: porterman expose <port[:ENV_VAR]> [port2[:ENV_VAR2]] ...");
      process.exit(1);
    }

    // Parse port arguments (supports "3000" and "3000:FRONTEND_URL")
    const portMappings: PortMapping[] = [];
    for (const arg of portsRaw) {
      try {
        const parsed = parsePortArg(arg);
        portMappings.push({ port: parsed.port, envVar: parsed.envVar });
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    let server: Awaited<ReturnType<typeof startServer>> | null = null;

    try {
      server = await startServer({
        ports: portMappings,
        verbose: options.verbose,
        envFile: options.envFile,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Eval mode: output exports and exit
    if (isEvalMode && server.envVars.size > 0) {
      console.log(formatExports(server.envVars));
    }

    if (!isEvalMode) {
      // Print ready message
      logger.blank();
      logger.success("Ready!");
      logger.blank();

      for (const [port, url] of server.urls) {
        const mapping = portMappings.find((m) => m.port === port);
        if (mapping?.envVar) {
          logger.link(`http://localhost:${port}`, `${url}  (${mapping.envVar})`);
        } else {
          logger.link(`http://localhost:${port}`, url);
        }
      }

      if (server.envVars.size > 0) {
        logger.blank();
        logger.info("Env variables written to .env.porterman");
      }

      logger.blank();
      console.log("  Press Ctrl+C to stop");
      logger.blank();
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

// Default command (show help)
cli.command("", "Show help").action(() => {
  cli.outputHelp();
});

cli.help();
cli.version(version);

cli.parse();
