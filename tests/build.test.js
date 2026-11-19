import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { test } from "node:test";

const assetsUrl = new URL("../dist/assets/", import.meta.url);

test("production build retains the lazily loaded LiveKit client", async () => {
  const files = await readdir(assetsUrl);
  const mainFile = files.find(file => /^index-.*\.js$/.test(file));
  const liveKitFile = files.find(file => /^livekit-client.*\.js$/.test(file));
  assert.ok(mainFile, "Vite main JavaScript bundle is present");
  assert.ok(liveKitFile, "LiveKit is emitted as a separate browser chunk");
  assert.ok((await stat(new URL(liveKitFile, assetsUrl))).size > 100_000, "LiveKit chunk contains SDK code");
  const mainBundle = await readFile(new URL(mainFile, assetsUrl), "utf8");
  assert.ok(mainBundle.includes(liveKitFile), "main bundle imports the LiveKit chunk dynamically");
});
