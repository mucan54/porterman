import * as acme from "acme-client";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { paths, ensureDirs, writeSecureFile } from "./config.js";
import { logger } from "./logger.js";

interface CertMeta {
  issuedAt: string;
  expiresAt: string;
  domains: string[];
}

interface CertFiles {
  key: string;
  cert: string;
  chain: string;
}

// In-memory store for ACME HTTP-01 challenge tokens
const challengeTokens = new Map<string, string>();

/**
 * Get or create the ACME account private key.
 */
async function getAccountKey(): Promise<Buffer> {
  await ensureDirs();
  if (existsSync(paths.accountKey)) {
    return readFile(paths.accountKey);
  }
  const key = await acme.crypto.createPrivateKey();
  await writeSecureFile(paths.accountKey, key.toString());
  return key;
}

/**
 * Check if an existing certificate is still valid (>30 days remaining).
 */
async function isCertValid(hostname: string): Promise<boolean> {
  const metaPath = paths.metaFile(hostname);
  if (!existsSync(metaPath)) return false;

  try {
    const data = await readFile(metaPath, "utf-8");
    const meta: CertMeta = JSON.parse(data);
    const expires = new Date(meta.expiresAt);
    const daysRemaining =
      (expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysRemaining > 30) {
      logger.verbose(
        `Certificate for ${hostname} valid for ${Math.floor(daysRemaining)} more days`
      );
      return true;
    }
    logger.verbose(
      `Certificate for ${hostname} expires in ${Math.floor(daysRemaining)} days, needs renewal`
    );
    return false;
  } catch {
    return false;
  }
}

/**
 * Load existing certificate files from disk.
 */
async function loadCertFromDisk(hostname: string): Promise<CertFiles> {
  const [key, cert, chain] = await Promise.all([
    readFile(paths.keyFile(hostname), "utf-8"),
    readFile(paths.certFile(hostname), "utf-8"),
    readFile(paths.chainFile(hostname), "utf-8"),
  ]);
  return { key, cert, chain };
}

/**
 * Create the HTTP-01 challenge handler for the ACME server.
 * This is used as middleware to respond to /.well-known/acme-challenge/ requests.
 */
export function handleAcmeChallenge(
  url: string
): string | null {
  const prefix = "/.well-known/acme-challenge/";
  if (!url.startsWith(prefix)) return null;
  const token = url.slice(prefix.length);
  return challengeTokens.get(token) ?? null;
}

/**
 * Obtain a certificate for a hostname via Let's Encrypt ACME.
 */
async function obtainCert(
  hostname: string,
  staging: boolean
): Promise<CertFiles> {
  const accountKey = await getAccountKey();

  const directoryUrl = staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  // Create a CSR
  const [certKey, csr] = await acme.crypto.createCsr({
    commonName: hostname,
  });

  // Order the certificate
  const cert = await client.auto({
    csr,
    email: "porterman@localhost",
    termsOfServiceAgreed: true,
    challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
      const token = _challenge.token;
      logger.verbose(`Setting ACME challenge token: ${token}`);
      challengeTokens.set(token, keyAuthorization);
    },
    challengeRemoveFn: async (_authz, _challenge) => {
      const token = _challenge.token;
      challengeTokens.delete(token);
    },
    challengePriority: ["http-01"],
  });

  // Save certificate files
  const certDir = paths.certDir(hostname);
  await mkdir(certDir, { recursive: true });

  const keyStr = certKey.toString();
  const certStr = cert.toString();

  await Promise.all([
    writeSecureFile(paths.keyFile(hostname), keyStr),
    writeFile(paths.certFile(hostname), certStr),
    writeFile(paths.chainFile(hostname), certStr),
  ]);

  // Save metadata
  const now = new Date();
  const meta: CertMeta = {
    issuedAt: now.toISOString(),
    // Let's Encrypt certs are valid for 90 days
    expiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    domains: [hostname],
  };
  await writeFile(paths.metaFile(hostname), JSON.stringify(meta, null, 2));

  return { key: keyStr, cert: certStr, chain: certStr };
}

/**
 * Generate a self-signed certificate as a fallback.
 */
async function generateSelfSigned(hostname: string): Promise<CertFiles> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  const certDir = paths.certDir(hostname);
  await mkdir(certDir, { recursive: true });

  const keyPath = paths.keyFile(hostname);
  const certPath = paths.certFile(hostname);

  await execAsync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -nodes -subj "/CN=${hostname}" 2>/dev/null`
  );

  await execAsync(`chmod 600 "${keyPath}"`);

  const [key, cert] = await Promise.all([
    readFile(keyPath, "utf-8"),
    readFile(certPath, "utf-8"),
  ]);

  // Write chain (same as cert for self-signed)
  await writeFile(paths.chainFile(hostname), cert);

  const now = new Date();
  const meta: CertMeta = {
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + 365 * 24 * 60 * 60 * 1000
    ).toISOString(),
    domains: [hostname],
  };
  await writeFile(paths.metaFile(hostname), JSON.stringify(meta, null, 2));

  return { key, cert, chain: cert };
}

export interface CertResult {
  key: string;
  cert: string;
  chain: string;
  selfSigned: boolean;
}

/**
 * Get a valid certificate for a hostname.
 * - First checks for a cached valid cert
 * - Then tries ACME/Let's Encrypt
 * - Falls back to self-signed if ACME fails
 */
export async function getCertificate(
  hostname: string,
  options: { staging?: boolean; forceRenew?: boolean } = {}
): Promise<CertResult> {
  await ensureDirs();

  // Check for existing valid cert
  if (!options.forceRenew && (await isCertValid(hostname))) {
    logger.verbose(`Using cached certificate for ${hostname}`);
    const files = await loadCertFromDisk(hostname);
    return { ...files, selfSigned: false };
  }

  // Try ACME
  try {
    logger.info(`Obtaining SSL certificate for ${hostname}...`);
    const files = await obtainCert(hostname, options.staging ?? false);
    logger.success(`Certificate obtained for ${hostname}`);
    return { ...files, selfSigned: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Let's Encrypt failed: ${message}`);
    logger.warn("Falling back to self-signed certificate");
    logger.warn(
      "Browsers will show a security warning. Consider using a custom domain."
    );

    const files = await generateSelfSigned(hostname);
    return { ...files, selfSigned: true };
  }
}

/**
 * Remove all cached certificates.
 */
export async function cleanCerts(): Promise<void> {
  const { rm } = await import("node:fs/promises");
  if (existsSync(paths.certs)) {
    await rm(paths.certs, { recursive: true, force: true });
    await mkdir(paths.certs, { recursive: true });
    logger.success("All cached certificates removed");
  }
}
