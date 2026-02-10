import { logger } from "./logger.js";
import { isPrivateIp, ipToDashed } from "./utils.js";

const IP_SERVICES = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
];

let cachedIp: string | null = null;

/**
 * Fetch public IP from a single service with timeout.
 */
async function fetchIpFrom(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim();
  } catch {
    return null;
  }
}

/**
 * Detect the machine's public IP address using multiple services with fallback.
 * Results are cached for the session lifetime.
 */
export async function detectPublicIp(): Promise<string> {
  if (cachedIp) return cachedIp;

  for (const service of IP_SERVICES) {
    logger.verbose(`Trying IP detection via ${service}`);
    const ip = await fetchIpFrom(service);
    if (ip && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
      if (isPrivateIp(ip)) {
        throw new Error(
          `Detected private IP address (${ip}). Porterman requires a public IP.\n` +
            "If you're behind NAT, you need a machine with a direct public IP (VPS, cloud instance, etc.).\n" +
            "You can also specify your IP manually with --host <ip>."
        );
      }
      cachedIp = ip;
      logger.verbose(`Public IP detected: ${ip}`);
      return ip;
    }
  }

  throw new Error(
    "Could not detect public IP address. All detection services failed.\n" +
      "Please specify your IP manually with --host <ip>."
  );
}

/**
 * Get the dashed format of the public IP (e.g., 85-100-50-25).
 */
export async function getDashedIp(overrideIp?: string): Promise<string> {
  const ip = overrideIp ?? (await detectPublicIp());
  if (overrideIp && isPrivateIp(overrideIp)) {
    logger.warn(
      `Specified IP ${overrideIp} appears to be a private address. sslip.io may not work correctly.`
    );
  }
  return ipToDashed(ip);
}

/**
 * Clear the cached IP (useful for testing).
 */
export function clearIpCache(): void {
  cachedIp = null;
}
