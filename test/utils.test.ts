import { describe, it, expect } from "vitest";
import {
  ipToDashed,
  makeHostname,
  parsePortFromHost,
  parsePrefixFromHost,
  isPrivateIp,
  isValidPort,
} from "../src/utils.js";

describe("ipToDashed", () => {
  it("converts dotted IP to dashed format", () => {
    expect(ipToDashed("85.100.50.25")).toBe("85-100-50-25");
  });

  it("handles single-digit octets", () => {
    expect(ipToDashed("1.2.3.4")).toBe("1-2-3-4");
  });

  it("handles three-digit octets", () => {
    expect(ipToDashed("255.255.255.255")).toBe("255-255-255-255");
  });
});

describe("makeHostname", () => {
  it("creates sslip.io hostname with port prefix", () => {
    expect(makeHostname(3000, "85-100-50-25")).toBe(
      "3000-85-100-50-25.sslip.io"
    );
  });

  it("creates sslip.io hostname with string prefix", () => {
    expect(makeHostname("myapp", "85-100-50-25")).toBe(
      "myapp-85-100-50-25.sslip.io"
    );
  });
});

describe("parsePortFromHost", () => {
  it("extracts port from sslip.io hostname", () => {
    expect(parsePortFromHost("3000-85-100-50-25.sslip.io")).toBe(3000);
  });

  it("extracts port from hostname with port suffix", () => {
    expect(parsePortFromHost("8080-85-100-50-25.sslip.io:443")).toBe(8080);
  });

  it("returns null for non-numeric prefix", () => {
    expect(parsePortFromHost("myapp-85-100-50-25.sslip.io")).toBeNull();
  });

  it("returns null for unrecognized format", () => {
    expect(parsePortFromHost("example.com")).toBeNull();
  });
});

describe("parsePrefixFromHost", () => {
  it("extracts prefix from hostname", () => {
    expect(parsePrefixFromHost("myapp-85-100-50-25.sslip.io")).toBe("myapp");
  });

  it("extracts numeric prefix", () => {
    expect(parsePrefixFromHost("3000-85-100-50-25.sslip.io")).toBe("3000");
  });
});

describe("isPrivateIp", () => {
  it("detects 10.x.x.x as private", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  it("detects 172.16-31.x.x as private", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  it("does not flag 172.15.x.x as private", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
  });

  it("does not flag 172.32.x.x as private", () => {
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("detects 192.168.x.x as private", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  it("detects 127.x.x.x as private", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
  });

  it("detects 0.0.0.0 as private", () => {
    expect(isPrivateIp("0.0.0.0")).toBe(true);
  });

  it("detects 169.254.x.x as private", () => {
    expect(isPrivateIp("169.254.1.1")).toBe(true);
  });

  it("returns false for public IPs", () => {
    expect(isPrivateIp("85.100.50.25")).toBe(false);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
  });

  it("returns true for invalid input", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("isValidPort", () => {
  it("accepts valid ports", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(80)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(3000)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it("rejects invalid ports", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
    expect(isValidPort(NaN)).toBe(false);
  });
});
