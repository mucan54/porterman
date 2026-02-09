import { describe, it, expect } from "vitest";
import { handleAcmeChallenge } from "../src/certs.js";

describe("handleAcmeChallenge", () => {
  it("returns null for non-ACME URLs", () => {
    expect(handleAcmeChallenge("/")).toBeNull();
    expect(handleAcmeChallenge("/index.html")).toBeNull();
    expect(handleAcmeChallenge("/api/data")).toBeNull();
  });

  it("returns null for unknown ACME tokens", () => {
    expect(
      handleAcmeChallenge("/.well-known/acme-challenge/unknown-token")
    ).toBeNull();
  });
});
