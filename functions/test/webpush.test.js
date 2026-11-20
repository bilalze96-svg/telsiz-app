import assert from "node:assert/strict";
import { test } from "node:test";
import { createEmergencyWebPush, deliverEmergencyWebPush, VAPID_PUBLIC_KEY } from "../webpush.js";

test("emergency web push carries only the sender name and opens the TELSIZ app", () => {
  assert.match(VAPID_PUBLIC_KEY, /^[A-Za-z0-9_-]{80,100}$/);
  assert.deepEqual(createEmergencyWebPush("Ece"), {
    title: "TELSİZ · ACİL DURUM",
    body: "Ece yardım çağrısı gönderdi.",
    tag: "telsiz-emergency",
    url: "/"
  });
});

test("emergency web push excludes sender, sends to registered devices and returns stale subscriptions", async () => {
  const calls = [];
  const stale = { id: "stale" };
  const result = await deliverEmergencyWebPush({
    senderUid: "sender",
    name: "Ece",
    devices: [
      { uid: "sender", endpoint: "https://push.example/sender", keys: { p256dh: "key", auth: "secret" }, reference: { id: "sender" } },
      { uid: "receiver", endpoint: "https://push.example/receiver", keys: { p256dh: "key", auth: "secret" }, reference: { id: "receiver" } },
      { uid: "stale-user", endpoint: "https://push.example/stale", keys: { p256dh: "key", auth: "secret" }, reference: stale }
    ],
    send: async (subscription, payload, options) => {
      calls.push({ subscription, payload: JSON.parse(payload), options });
      if (subscription.endpoint.endsWith("stale")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].subscription.endpoint, "https://push.example/receiver");
  assert.equal(calls[0].payload.body, "Ece yardım çağrısı gönderdi.");
  assert.deepEqual(calls[0].options, { TTL: 60 });
  assert.deepEqual(result, { registered: 2, delivered: 1, stale: [stale] });
});
