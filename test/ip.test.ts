import { describe, it, expect, vi, afterEach } from "vitest";
import { clearIpCache } from "../src/ip.js";

// We test the IP module at a unit level, mocking fetch

afterEach(() => {
  clearIpCache();
  vi.restoreAllMocks();
});

describe("detectPublicIp", () => {
  it("returns a public IP from the primary service", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("85.100.50.25"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { detectPublicIp } = await import("../src/ip.js");
    clearIpCache();

    const ip = await detectPublicIp();
    expect(ip).toBe("85.100.50.25");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to secondary service if primary fails", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("1.2.3.4"),
      });
    vi.stubGlobal("fetch", mockFetch);

    const { detectPublicIp } = await import("../src/ip.js");
    clearIpCache();

    const ip = await detectPublicIp();
    expect(ip).toBe("1.2.3.4");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws if a private IP is detected", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("192.168.1.1"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { detectPublicIp } = await import("../src/ip.js");
    clearIpCache();

    await expect(detectPublicIp()).rejects.toThrow("private IP");
  });

  it("throws if all services fail", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", mockFetch);

    const { detectPublicIp } = await import("../src/ip.js");
    clearIpCache();

    await expect(detectPublicIp()).rejects.toThrow(
      "Could not detect public IP"
    );
  });
});

describe("getDashedIp", () => {
  it("returns dashed format of detected IP", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("85.100.50.25"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { getDashedIp } = await import("../src/ip.js");
    clearIpCache();

    const dashed = await getDashedIp();
    expect(dashed).toBe("85-100-50-25");
  });

  it("uses override IP when provided", async () => {
    const { getDashedIp } = await import("../src/ip.js");
    const dashed = await getDashedIp("1.2.3.4");
    expect(dashed).toBe("1-2-3-4");
  });
});
