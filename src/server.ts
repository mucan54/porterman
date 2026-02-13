import { startTunnel, startTunnels, type TunnelInstance } from "./tunnel.js";
import { writePidFile, paths } from "./config.js";
import { writeEnvFile, cleanEnvFile } from "./env.js";
import { logger, setVerbose } from "./logger.js";
import { isValidPort } from "./utils.js";

export interface PortMapping {
  port: number;
  envVar?: string;
}

export interface ServerOptions {
  ports: (number | PortMapping)[];
  verbose?: boolean;
  envFile?: string;
}

export interface PortermanServer {
  close(): Promise<void>;
  urls: Map<number, string>;
  envVars: Map<string, string>;
  tunnels: TunnelInstance[];
}

export async function startServer(options: ServerOptions): Promise<PortermanServer> {
  const { ports, verbose = false, envFile } = options;

  setVerbose(verbose);

  if (ports.length === 0) {
    throw new Error("At least one port is required");
  }

  // Normalize to PortMapping[]
  const mappings: PortMapping[] = ports.map((p) =>
    typeof p === "number" ? { port: p } : p
  );

  // Validate ports
  for (const mapping of mappings) {
    if (!isValidPort(mapping.port)) {
      throw new Error(`Invalid port number: ${mapping.port}`);
    }
  }

  // Remove duplicate ports (keep first mapping per port)
  const seen = new Set<number>();
  const uniqueMappings = mappings.filter((m) => {
    if (seen.has(m.port)) return false;
    seen.add(m.port);
    return true;
  });

  const uniquePorts = uniqueMappings.map((m) => m.port);

  logger.info(`Starting ${uniquePorts.length} tunnel${uniquePorts.length > 1 ? "s" : ""}...`);

  // Start all tunnels concurrently
  const tunnels = await startTunnels(uniquePorts, { verbose });

  // Write PID file
  await writePidFile(process.pid);

  // Build URL map
  const urls = new Map<number, string>();
  for (const tunnel of tunnels) {
    urls.set(tunnel.port, tunnel.url);
  }

  // Build env variable map and write .env file if any env vars are specified
  const envVars = new Map<string, string>();
  const hasEnvMappings = uniqueMappings.some((m) => m.envVar);

  if (hasEnvMappings) {
    for (const mapping of uniqueMappings) {
      if (mapping.envVar) {
        const url = urls.get(mapping.port);
        if (url) {
          envVars.set(mapping.envVar, url);
        }
      }
    }

    const envFilePath = await writeEnvFile(envVars, envFile);
    logger.success(`Environment file written: ${envFilePath}`);
  }

  // Graceful shutdown
  async function close(): Promise<void> {
    logger.info("Shutting down tunnels...");
    for (const tunnel of tunnels) {
      tunnel.stop();
    }

    // Clean up env file
    if (hasEnvMappings) {
      await cleanEnvFile(envFile);
    }

    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.pidFile);
    } catch {}

    logger.success("Stopped");
  }

  return { close, urls, envVars, tunnels };
}
