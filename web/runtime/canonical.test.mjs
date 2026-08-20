import { expect, test } from "bun:test";

import { sha256Hex } from "./canonical.mjs";

test("portable SHA-256 matches the standard byte vectors", () => {
  for (const [value, expected] of [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
    [
      new TextEncoder().encode("Wake \u{1f9ad} Store"),
      "d9161227df027b70ce0299794bb9578513a27a5cd47268a7aa3e85c7df1d550f",
    ],
  ]) {
    expect(sha256Hex(value)).toBe(expected);
  }
});

test("portable SHA-256 matches Bun over multiple compression blocks", () => {
  const bytes = Uint8Array.from({ length: 4097 }, (_, index) => index % 251);
  const expected = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(sha256Hex(bytes)).toBe(expected);
});
