import assert from "node:assert/strict";
import { test } from "node:test";
import { createTurnCredentials } from "../turn.js";

const accountSid = `AC${"a".repeat(32)}`;

test("Twilio TURN credentials are requested with a short lifetime and server-only auth", async () => {
  let request;
  const iceServers = [
    { urls: "stun:global.stun.twilio.com:3478" },
    { urls: "turn:global.turn.twilio.com:3478?transport=udp", username: "short", credential: "secret" }
  ];
  const result = await createTurnCredentials({
    accountSid,
    authToken: "twilio-auth",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ice_servers: iceServers }) };
    }
  });
  assert.deepEqual(result, iceServers);
  assert.equal(request.options.method, "POST");
  assert.equal(new URLSearchParams(request.options.body).get("Ttl"), "3600");
  assert.equal(request.options.headers.authorization, `Basic ${Buffer.from(`${accountSid}:twilio-auth`).toString("base64")}`);
});

test("invalid Twilio account IDs and unsuccessful responses are rejected", async () => {
  await assert.rejects(createTurnCredentials({ accountSid: "invalid", authToken: "x" }), /not configured/);
  await assert.rejects(createTurnCredentials({
    accountSid,
    authToken: "x",
    fetchImpl: async () => ({ ok: false, status: 403 })
  }), /403/);
});
