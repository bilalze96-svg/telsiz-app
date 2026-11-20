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

test("backgrounding mutes push-to-talk without explicitly leaving the channel", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes('window.addEventListener("pagehide", muteForBackground);'));
  assert.ok(!app.includes("window.addEventListener(\"pagehide\", exitForPageClose)"));
  assert.ok(app.includes("async function restorePresence()"));
});

test("name is saved as it is typed and radio release has a transmitted tone", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes('$("nameInput").addEventListener("input", () => rememberName($("nameInput").value));'));
  assert.ok(app.includes("function playReleaseTone()"));
  assert.ok(app.includes("playReleaseTone();"));
});

test("radio speech is band-limited, saturated, compressed, and mixed with gated static", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes('highPass.frequency.value = 285;'));
  assert.ok(app.includes('lowPass.frequency.value = 2450;'));
  assert.ok(app.includes('presence.type = "peaking";'));
  assert.ok(app.includes('compressor.ratio.value = 10;'));
  assert.ok(app.includes('noiseBand.type = "bandpass";'));
  assert.ok(app.includes('value ? 0.022 : 0'));
  assert.ok(app.includes('radioNoiseGain).connect(destination)'));
});

test("one tap sends an emergency alert directly through Firestore", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.equal((html.match(/class="emergency-button"/g) || []).length, 2);
  assert.ok(html.includes("🆘 ACİL DURUM BİLDİR"));
  assert.ok(!app.includes("emergencyHoldTimer"));
  assert.ok(app.includes('button.addEventListener("click", () => void sendEmergencyAlert(button))'));
  assert.ok(app.includes("await publishEmergencyToOpenClients(user.uid, name)"));
  assert.ok(app.includes('doc(db, "webPushDevices", user.uid)'));
  assert.ok(app.includes("registration.pushManager.subscribe"));
});

test("the service worker displays remote push alerts and keeps clicks on this site", async () => {
  const serviceWorker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.ok(serviceWorker.includes('self.addEventListener("push"'));
  assert.ok(serviceWorker.includes("self.registration.showNotification(title, options)"));
  assert.ok(serviceWorker.includes("url.origin === self.location.origin"));
});
