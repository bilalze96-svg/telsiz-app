import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));

test("PWA manifest declares app identity, standalone display, and local icons", async () => {
  assert.equal(manifest.name, "TELSİZ");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  for (const path of [
    "../public/icons/icon.svg",
    "../public/icons/icon-192.png",
    "../public/icons/icon-512.png",
    "../public/icons/apple-touch-icon.png",
    "../public/sw.js"
  ]) {
    await access(new URL(path, import.meta.url));
  }
});

test("raster app icons have the declared PNG dimensions", async () => {
  for (const [file, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
    const icon = await readFile(new URL(`../public/icons/${file}`, import.meta.url));
    assert.equal(icon.toString("ascii", 1, 4), "PNG");
    assert.equal(icon.readUInt32BE(16), size);
    assert.equal(icon.readUInt32BE(20), size);
  }
});
