import { describe, expect, it } from "vitest";

import {
  evmWindowFingerprint,
  formatUqor,
  messageType,
  normalizeAddress,
  shortAddress,
} from "./qore.js";

describe("address handling", () => {
  it("normalises a native qor address and derives the EVM twin", () => {
    const result = normalizeAddress("qor155tcurt9e5hz03524m0tn2z4z2uh7wvtctf5rt");
    expect(result).toEqual({
      address: "qor155tcurt9e5hz03524m0tn2z4z2uh7wvtctf5rt",
      evmAddress: "0xa5178e0d65cd2e27c68aaedeb9a85512b97f398b",
    });
  });

  it("converts an EVM address back to its native twin", () => {
    const result = normalizeAddress("0xa5178e0d65cd2e27c68aaedeb9a85512b97f398b");
    expect(result?.address).toBe("qor155tcurt9e5hz03524m0tn2z4z2uh7wvtctf5rt");
    expect(result?.evmAddress).toBe("0xa5178e0d65cd2e27c68aaedeb9a85512b97f398b");
  });

  it("rejects malformed addresses", () => {
    expect(normalizeAddress("qor1not-an-address")).toBeNull();
    expect(normalizeAddress("0x1234")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });

  it("shortens without losing both ends", () => {
    expect(shortAddress("qor155tcurt9e5hz03524m0tn2z4z2uh7wvtctf5rt")).toBe(
      "qor155tc…ctf5rt",
    );
  });
});

describe("amounts and messages", () => {
  it("formats micro-QOR as QOR", () => {
    expect(formatUqor(1)).toBe("0.000001 QOR");
    expect(formatUqor("150000")).toBe("0.15 QOR");
    expect(formatUqor("1000000")).toBe("1 QOR");
    expect(formatUqor("1000001")).toBe("1.000001 QOR");
  });

  it("reads the message type from the REST type URL", () => {
    expect(
      messageType({ "@type": "/cosmos.bank.v1beta1.MsgSend" }),
    ).toBe("/cosmos.bank.v1beta1.MsgSend");
  });
});

describe("EVM window fingerprints", () => {
  it("serialises bigint window fields without throwing", () => {
    const fingerprint = evmWindowFingerprint({
      found: true,
      live: true,
      expiryHeight: 123n,
      remainingTxs: 4n,
      remainingBlocks: 20n,
      nativeOnly: false,
      allowedTargets: ["0xabc"],
    } as never);
    expect(JSON.parse(fingerprint)).toMatchObject({
      found: true,
      live: true,
      expiryHeight: "123",
      remainingTxs: "4",
    });
  });
});
