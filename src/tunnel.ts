import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { Tunnel, bin as cloudflaredBin, install } from "cloudflared";
import { logger } from "./logger.js";

export interface TunnelInstance {
  /** The public URL assigned by Cloudflare */
  url: string;
  /** The local port being tunneled */
  port: number;
  /** Stop this tunnel */
  stop(): void;
}

/** Maximum age for the cloudflared binary before we warn (365 days). */
const MAX_BINARY_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse a cloudflared version string like "cloudflared version 2025.2.0 (built 2025-02-10-...)"
 * or "2025.2.0" into a Date based on the YYYY.M.0 convention (year.month).
 * Returns null if parsing fails.
 */
export function parseCloudflaredVersion(versionOutput: string): { version: string; date: Date } | null {
  // Match patterns like "2025.2.0" or "2026.3.0"
  const match = versionOutput.match(/(\d{4})\.(\d{1,2})\.(\d+)/);
  if (!match) return null;

  const [, yearStr, monthStr] = match;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  if (year < 2020 || year > 2100 || month < 1 || month > 12) return null;

  return {
    version: match[0],
    date: new Date(year, month - 1, 1),
  };
}

/**
 * Ensure the cloudflared binary is installed and not outdated.
 * - If missing: auto-installs the latest version.
 * - If outdated (>1 year): warns the user and suggests updating.
 * Throws if installation fails.
 */
export async function ensureCloudflared(): Promise<void> {
  if (!existsSync(cloudflaredBin)) {
    logger.info("cloudflared binary not found — downloading latest version...");
    try {
      await install(dirname(cloudflaredBin));
      logger.success("cloudflared installed successfully");
    } catch (err) {
      throw new Error(
        `Failed to download cloudflared: ${err instanceof Error ? err.message : String(err)}\n` +
        `You can install it manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
      );
    }
  }

  // Check version / staleness
  try {
    const output = execFileSync(cloudflaredBin, ["--version"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    logger.verbose(`cloudflared version output: ${output}`);

    const parsed = parseCloudflaredVersion(output);
    if (parsed) {
      const ageMs = Date.now() - parsed.date.getTime();
      if (ageMs > MAX_BINARY_AGE_MS) {
        const months = Math.floor(ageMs / (30 * 24 * 60 * 60 * 1000));
        logger.warn(
          `cloudflared ${parsed.version} is ~${months} months old. ` +
          `Cloudflare only supports versions within 1 year of the latest release.`
        );
        logger.warn(
          `Update with: npx cloudflared bin remove && npx cloudflared bin install latest`
        );
      } else {
        logger.verbose(`cloudflared ${parsed.version} is up to date`);
      }
    }
  } catch {
    // Non-fatal — if we can't check the version, just proceed
    logger.verbose("Could not determine cloudflared version");
  }
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
