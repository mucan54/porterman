import cac from "cac";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { startServer, type PortMapping } from "./server.js";
import { parsePortArg, formatExports } from "./env.js";
import { readPidFile, pidFileExists, writePidFile, paths } from "./config.js";
import { logger, setVerbose } from "./logger.js";
import { startTunnels } from "./tunnel.js";
import {
  loadSettings,
  createBackup,
  writeBackupFile,
  readBackupFile,
  applySettings,
  restoreFromBackup,
  getBackupFilePath,
} from "./settings.js";

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
  .option("--cleanup", "Delete backup file on shutdown (default: true)")
  .option("--no-cleanup", "Keep backup file on shutdown")
  .action(async (portsRaw: string[], options) => {
    const isEvalMode = options.eval === true;

    if (!isEvalMode) {
      logger.banner(version);
      logger.blank();
    }

    // ── Settings mode detection ──────────────────────────────────
    // If the first argument is not a valid port number, treat it as a settings name.
    // This ensures "porterman expose settings" always enters settings mode,
    // and gives a clear "file not found" error if the config doesn't exist.
    const settingsName = portsRaw?.[0];
    const isSettingsMode =
      settingsName &&
      portsRaw.length === 1 &&
      isNaN(parseInt(settingsName, 10));

    if (isSettingsMode) {
      const settingsFile = `${settingsName}.porterman.json`;
      // Load and validate config
      let config;
      try {
        config = loadSettings(settingsName);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Merge config options with CLI flags (CLI wins)
      const verbose = options.verbose ?? config.verbose ?? false;
      const cleanup = options.cleanup ?? config.cleanup ?? true;
      setVerbose(verbose);

      logger.info(`Loading ${settingsFile}...`);

      // Crash recovery: if backup exists from a previous run, restore first
      const existingBackup = readBackupFile(settingsName);
      if (existingBackup) {
        logger.warn(
          "Found backup from a previous session — restoring original values first..."
        );
        try {
          await restoreFromBackup(settingsName, existingBackup);
          logger.success("Previous session restored successfully");
        } catch (err) {
          logger.warn(
            `Failed to restore previous backup: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Extract unique ports
      const ports = [
        ...new Set(
          Object.keys(config.tunnels).map((p) => parseInt(p, 10))
        ),
      ];

      // Create backup before modifying anything
      const manifest = createBackup(config);
      writeBackupFile(settingsName, manifest);

      logger.info(
        `Starting ${ports.length} tunnel${ports.length > 1 ? "s" : ""}...`
      );

      // Start tunnels
      let tunnels;
      try {
        tunnels = await startTunnels(ports, { verbose });
      } catch (err) {
        // Cleanup backup on tunnel failure
        try {
          const { unlink: unlinkFile } = await import("node:fs/promises");
          await unlinkFile(getBackupFilePath(settingsName));
        } catch {}
        logger.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Write PID file
      await writePidFile(process.pid);

      // Build tunnel URL map
      const tunnelUrls = new Map<number, string>();
      for (const tunnel of tunnels) {
        tunnelUrls.set(tunnel.port, tunnel.url);
      }

      logger.success("Tunnels ready!");
      logger.blank();

      for (const tunnel of tunnels) {
        logger.link(
          `http://localhost:${tunnel.port}`,
          tunnel.url
        );
      }

      // Apply settings (write env variables)
      try {
        await applySettings(config, tunnelUrls);
      } catch (err) {
        logger.error(
          `Failed to apply settings: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Log modified variables grouped by file
      logger.blank();
      logger.success("Environment variables updated:");
      const loggedFiles = new Map<string, Array<{ key: string; value: string }>>();
      for (const [portStr, tunnel] of Object.entries(config.tunnels)) {
        const port = parseInt(portStr, 10);
        const url = tunnelUrls.get(port);
        if (!url) continue;
        const hostname = new URL(url).hostname;
        for (const target of tunnel.envFiles) {
          const displayPath = target.filePath
            ? `${target.filePath}/${target.file}`
            : target.file;
          if (!loggedFiles.has(displayPath)) {
            loggedFiles.set(displayPath, []);
          }
          for (const [key, rawValue] of Object.entries(target.variables)) {
            let value: string;
            if (rawValue === "$tunnelUrl") {
              value = url;
            } else if (rawValue === "$tunnelHostname") {
              value = hostname;
            } else {
              value = String(rawValue);
            }
            loggedFiles.get(displayPath)!.push({ key, value });
          }
        }
      }
      for (const [filePath, vars] of loggedFiles) {
        logger.info(`  ${filePath}`);
        for (const { key, value } of vars) {
          console.log(`    ${key} = ${value}`);
        }
      }

      logger.blank();
      logger.success(
        `Backup saved to .${settingsName}.porterman.backup.env`
      );
      logger.blank();
      console.log("  Press Ctrl+C to stop");
      logger.blank();

      // Shutdown handler
      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.info("Shutting down tunnels...");

        try {
          await restoreFromBackup(settingsName, manifest);
          logger.success("Environment variables restored from backup");
        } catch (err) {
          logger.error(
            `Failed to restore backup: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        for (const tunnel of tunnels) {
          tunnel.stop();
        }

        // Clean PID file
        try {
          const { unlink: unlinkFile } = await import("node:fs/promises");
          await unlinkFile(paths.pidFile);
        } catch {}

        // If cleanup is disabled, re-create backup so it persists
        if (!cleanup) {
          writeBackupFile(settingsName, manifest);
        }

        logger.success("Stopped");
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("uncaughtException", async (err) => {
        logger.error(`Unexpected error: ${err.message}`);
        await shutdown();
      });
      process.on("unhandledRejection", async (reason) => {
        logger.error(
          `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`
        );
        await shutdown();
      });

      return;
    }

    // ── Normal port-based expose flow ────────────────────────────

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
