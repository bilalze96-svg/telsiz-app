import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const dist = new URL("../dist/", import.meta.url);

test("production build includes the fixed-channel push-to-talk app without LiveKit", async () => {
  const files = await readdir(new URL("assets/", dist));
  const bundle = files.find(file => /^index-.*\.js$/.test(file));
  assert.ok(bundle, "Vite JavaScript bundle is present");
  assert.ok(!files.some(file => file.toLowerCase().includes("livekit")), "unneeded SFU client is not bundled");
  const javascript = await readFile(new URL(`assets/${bundle}`, dist), "utf8");
  const html = await readFile(new URL("index.html", dist), "utf8");
  assert.ok(javascript.includes("stun:stun.l.google.com:19302"), "direct WebRTC uses a STUN server");
  assert.ok(html.includes("BASILI TUT, KONUŞ"), "page contains the push-to-talk control");
  assert.ok(html.includes("GENEL KANAL"), "page contains the shared fixed channel");
});
