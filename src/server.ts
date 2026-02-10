import { startTunnel, startTunnels, type TunnelInstance } from "./tunnel.js";
import { writePidFile, paths } from "./config.js";
import { logger, setVerbose } from "./logger.js";
import { isValidPort } from "./utils.js";

export interface ServerOptions {
  ports: number[];
  verbose?: boolean;
}

export interface PortermanServer {
  close(): Promise<void>;
  urls: Map<number, string>;
  tunnels: TunnelInstance[];
}

export async function startServer(options: ServerOptions): Promise<PortermanServer> {
  const { ports, verbose = false } = options;

  setVerbose(verbose);

  if (ports.length === 0) {
    throw new Error("At least one port is required");
  }

  // Validate ports
  for (const port of ports) {
    if (!isValidPort(port)) {
      throw new Error(`Invalid port number: ${port}`);
    }
  }

  // Remove duplicates
  const uniquePorts = [...new Set(ports)];

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

  // Graceful shutdown
  async function close(): Promise<void> {
    logger.info("Shutting down tunnels...");
    for (const tunnel of tunnels) {
      tunnel.stop();
    }

    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.pidFile);
    } catch {}

    logger.success("Stopped");
  }

  return { close, urls, tunnels };
}
