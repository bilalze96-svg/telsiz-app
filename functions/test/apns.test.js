import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createProviderToken, createPttPayload } from "../apns.js";

test("Apple provider JWT uses ES256 claims and the configured key id", () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const token = createProviderToken({
    keyId: "ABC123DEFG",
    teamId: "TEAM123456",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    now: 1_800_000_000_000
  });
  const [header, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "ES256", kid: "ABC123DEFG", typ: "JWT"
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iss: "TEAM123456", iat: 1_800_000_000
  });
  assert.equal(Buffer.from(signature, "base64url").length, 64);
});

test("PTT wake payload contains only the active speaker and channel metadata", () => {
  assert.deepEqual(createPttPayload({ activeSpeaker: "Ece", sessionId: "speaker-session" }), {
    activeSpeaker: "Ece", speakerSession: "speaker-session", channel: "general"
  });
});
