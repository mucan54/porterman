const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function isVerbose(): boolean {
  return verboseEnabled;
}

export const logger = {
  info(message: string): void {
    console.log(`${CYAN}ℹ${RESET} ${message}`);
  },

  success(message: string): void {
    console.log(`${GREEN}✅${RESET} ${message}`);
  },

  warn(message: string): void {
    console.log(`${YELLOW}⚠${RESET}  ${message}`);
  },

  error(message: string): void {
    console.error(`${RED}✖${RESET} ${message}`);
  },

  rocket(message: string): void {
    console.log(`🚀 ${message}`);
  },

  link(label: string, url: string): void {
    console.log(`  ${GREEN}${url}${RESET} → ${DIM}${label}${RESET}`);
  },

  verbose(message: string): void {
    if (verboseEnabled) {
      console.log(`${DIM}[verbose] ${message}${RESET}`);
    }
  },

  request(method: string, host: string, path: string, status: number): void {
    if (!verboseEnabled) return;
    const color = status < 400 ? GREEN : status < 500 ? YELLOW : RED;
    const time = new Date().toISOString().slice(11, 19);
    console.log(
      `${DIM}${time}${RESET} ${BOLD}${method}${RESET} ${host}${path} ${color}${status}${RESET}`
    );
  },

  banner(version: string): void {
    console.log(`\n${BOLD}🚪 Porterman v${version}${RESET}`);
  },

  blank(): void {
    console.log();
  },
};
