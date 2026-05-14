import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlatform } from "./platform.js";

test("somente profile com spotify", () => {
  const result = resolvePlatform({
    profileItem: { service: "spotify" },
    recentItem: null,
  });

  assert.deepEqual(result, {
    primary: "spotify",
    source: "profile",
    confidence: "medium",
    profileServiceCandidate: {
      platform: "spotify",
      confidence: "high",
      sourceKey: "service",
      rawValue: "spotify",
    },
    recentItemServiceCandidate: {
      platform: "unknown",
      confidence: "low",
      sourceKey: null,
      rawValue: null,
    },
  });
});

test("somente recent com apple music", () => {
  const result = resolvePlatform({
    profileItem: null,
    recentItem: { platform: "apple music" },
  });

  assert.equal(result.primary, "appleMusic");
  assert.equal(result.source, "recentItem");
  assert.equal(result.confidence, "high");
});

test("conflito profile/recent (prioriza recent)", () => {
  const result = resolvePlatform({
    profileItem: { service: "spotify" },
    recentItem: { platform: "apple music" },
  });

  assert.equal(result.primary, "appleMusic");
  assert.equal(result.source, "recentItem");
  assert.equal(result.confidence, "high");
});

test("sem sinais (unknown)", () => {
  const result = resolvePlatform({
    profileItem: { foo: "bar" },
    recentItem: { baz: "qux" },
  });

  assert.equal(result.primary, "unknown");
  assert.equal(result.source, "unknown");
  assert.equal(result.confidence, "low");
});
