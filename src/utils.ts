import { createServer, type Server } from "node:net";

/**
 * Convert a dotted IP address to dashed format.
 * 85.100.50.25 → 85-100-50-25
 */
export function ipToDashed(ip: string): string {
  return ip.replace(/\./g, "-").replace(/:/g, "-");
}

/**
 * Generate a sslip.io hostname for a given port and IP.
 */
export function makeHostname(
  port: number | string,
  dashedIp: string
): string {
  return `${port}-${dashedIp}.sslip.io`;
}

/**
 * Parse the port number from a sslip.io hostname.
 * "3000-85-100-50-25.sslip.io" → 3000
 */
export function parsePortFromHost(host: string): number | null {
  // Remove port suffix if present (e.g., ":443")
  const hostname = host.split(":")[0];
  // Extract the prefix before the first dash followed by IP-like pattern
  const match = hostname.match(/^(\w+)-\d+-/);
  if (!match) return null;
  const prefix = match[1];
  const port = parseInt(prefix, 10);
  return isNaN(port) ? null : port;
}

/**
 * Parse custom name from hostname.
 * "myapp-85-100-50-25.sslip.io" → "myapp"
 */
export function parsePrefixFromHost(host: string): string | null {
  const hostname = host.split(":")[0];
  const match = hostname.match(/^(\w+)-\d+-/);
  return match ? match[1] : null;
}

/**
 * Check if an IP is a private/reserved address.
 */
export function isPrivateIp(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true;

  // 10.0.0.0/8
  if (parts[0] === 10) return true;
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 127.0.0.0/8
  if (parts[0] === 127) return true;
  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true;
  // 169.254.0.0/16 (link-local)
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

/**
 * Check if a port is available.
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

/**
 * Validate that a port number is valid.
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
