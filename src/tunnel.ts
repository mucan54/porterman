import { Tunnel, type Connection } from "cloudflared";
import { logger } from "./logger.js";

export interface TunnelInstance {
  /** The public URL assigned by Cloudflare */
  url: string;
  /** The local port being tunneled */
  port: number;
  /** Stop this tunnel */
  stop(): void;
}

/**
 * Start a Cloudflare Quick Tunnel for a local port.
 * Returns a promise that resolves once the tunnel URL is available.
 */
export function startTunnel(port: number, options: { verbose?: boolean } = {}): Promise<TunnelInstance> {
  return new Promise<TunnelInstance>((resolve, reject) => {
    const localUrl = `http://localhost:${port}`;
    logger.verbose(`Starting tunnel for ${localUrl}...`);

    const tunnel = Tunnel.quick(localUrl);

    const timeout = setTimeout(() => {
      tunnel.stop();
      reject(new Error(`Tunnel for port ${port} timed out after 30 seconds`));
    }, 30_000);

    tunnel.once("url", (url: string) => {
      clearTimeout(timeout);
      logger.verbose(`Tunnel for port ${port} connected: ${url}`);
      resolve({
        url,
        port,
        stop: () => tunnel.stop(),
      });
    });

    tunnel.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`Tunnel for port ${port} failed: ${err.message}`));
    });

    tunnel.on("exit", (code: number | null) => {
      if (code !== null && code !== 0) {
        logger.verbose(`Tunnel for port ${port} exited with code ${code}`);
      }
    });

    if (options.verbose) {
      tunnel.on("stderr", (data: string) => {
        for (const line of data.split("\n").filter(Boolean)) {
          logger.verbose(`[cloudflared:${port}] ${line.trim()}`);
        }
      });
    }
  });
}

/**
 * Start tunnels for multiple ports concurrently.
 */
export async function startTunnels(
  ports: number[],
  options: { verbose?: boolean } = {}
): Promise<TunnelInstance[]> {
  const results = await Promise.all(
    ports.map((port) => startTunnel(port, options))
  );
  return results;
}
