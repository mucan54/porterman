import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORTERMAN_DIR = join(homedir(), ".porterman");
const CONFIG_FILE = join(PORTERMAN_DIR, "config.json");
const CERTS_DIR = join(PORTERMAN_DIR, "certs");
const ACCOUNT_KEY_FILE = join(PORTERMAN_DIR, "account.pem");
const PID_FILE = join(PORTERMAN_DIR, "porterman.pid");

export interface PortermanConfig {
  defaultTimeout?: number;
  defaultHttpPort?: number;
  defaultHttpsPort?: number;
}

export const paths = {
  base: PORTERMAN_DIR,
  config: CONFIG_FILE,
  certs: CERTS_DIR,
  accountKey: ACCOUNT_KEY_FILE,
  pidFile: PID_FILE,

  certDir(hostname: string): string {
    return join(CERTS_DIR, hostname);
  },

  certFile(hostname: string): string {
    return join(CERTS_DIR, hostname, "cert.pem");
  },

  keyFile(hostname: string): string {
    return join(CERTS_DIR, hostname, "privkey.pem");
  },

  chainFile(hostname: string): string {
    return join(CERTS_DIR, hostname, "chain.pem");
  },

  metaFile(hostname: string): string {
    return join(CERTS_DIR, hostname, "meta.json");
  },
};

export async function ensureDirs(): Promise<void> {
  await mkdir(PORTERMAN_DIR, { recursive: true });
  await mkdir(CERTS_DIR, { recursive: true });
}

export async function loadConfig(): Promise<PortermanConfig> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function saveConfig(config: PortermanConfig): Promise<void> {
  await ensureDirs();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function writeSecureFile(
  filePath: string,
  content: string
): Promise<void> {
  await writeFile(filePath, content, { mode: 0o600 });
}

export async function writePidFile(pid: number): Promise<void> {
  await ensureDirs();
  await writeFile(PID_FILE, String(pid));
}

export async function readPidFile(): Promise<number | null> {
  try {
    const data = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(data.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function pidFileExists(): boolean {
  return existsSync(PID_FILE);
}
