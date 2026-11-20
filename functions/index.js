import { getApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { createProviderToken, createPttPayload, sendPttPush } from "./apns.js";
import { createTurnCredentials } from "./turn.js";
import { deliverEmergencyWebPush, VAPID_PUBLIC_KEY } from "./webpush.js";
import { setVapidDetails } from "web-push";

initializeApp();

const apnsKey = defineSecret("TELSIZ_APNS_AUTH_KEY");
const webPushPrivateKey = defineSecret("TELSIZ_WEBPUSH_PRIVATE_KEY");
const apnsKeyId = defineString("TELSIZ_APNS_KEY_ID");
const appleTeamId = defineString("TELSIZ_APPLE_TEAM_ID");
const iosBundleId = defineString("TELSIZ_IOS_BUNDLE_ID", { default: "com.bilalze96.telsiz" });
const emergencyCooldownMs = 120_000;
const twilioAccountSid = defineString("TELSIZ_TWILIO_ACCOUNT_SID");
const twilioAuthToken = defineSecret("TELSIZ_TWILIO_AUTH_TOKEN");
let cachedProviderToken = "";
let tokenCreatedAt = 0;

function getProviderToken() {
  if (cachedProviderToken && Date.now() - tokenCreatedAt < 45 * 60 * 1000) return cachedProviderToken;
  cachedProviderToken = createProviderToken({
    keyId: apnsKeyId.value(),
    teamId: appleTeamId.value(),
    privateKey: apnsKey.value()
  });
  tokenCreatedAt = Date.now();
  return cachedProviderToken;
}

export const notifyNativePttListeners = onDocumentUpdated({
  document: "members/{sessionId}",
  database: "default",
  region: "europe-west3",
  secrets: [apnsKey],
  maxInstances: 2
}, async event => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.talking === true || after.talking !== true) return;

  const db = getFirestore(getApp(), "default");
  const senderSession = event.params.sessionId;
  const senderName = typeof after.name === "string" ? after.name.slice(0, 24) : "Ekip üyesi";
  const tokenSnapshot = await db.collection("pttTokens").get();
  const pushes = tokenSnapshot.docs
    .map(document => ({ reference: document.ref, data: document.data() }))
    .filter(({ data }) => data.sessionId !== senderSession &&
      typeof data.token === "string" &&
      ["sandbox", "production"].includes(data.environment));
  if (pushes.length === 0) return;
  const providerToken = getProviderToken();

  const results = await Promise.allSettled(pushes.map(async ({ reference, data }) => {
    try {
      await sendPttPush({
        token: data.token,
        environment: data.environment,
        bundleId: iosBundleId.value(),
        providerToken,
        payload: createPttPayload({ activeSpeaker: senderName, sessionId: senderSession })
      });
    } catch (error) {
      if (error.status === 410 || /Unregistered|BadDeviceToken/.test(error.message)) {
        await reference.delete().catch(() => {});
      }
      throw error;
    }
  }));

  const failed = results.filter(result => result.status === "rejected");
  if (failed.length) logger.warn("Some native PTT wake pushes failed", { failed: failed.length, total: results.length });
  logger.info("Native PTT wake pushes sent", { total: pushes.length, failed: failed.length });
});

export const sendEmergencyAlert = onCall({
  region: "europe-west3",
  secrets: [webPushPrivateKey],
  maxInstances: 2
}, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Anonymous sign-in is required.");
  const name = typeof request.data?.name === "string" ? request.data.name.trim().slice(0, 24) : "";
  if (!name) throw new HttpsError("invalid-argument", "A display name is required.");

  const db = getFirestore(getApp(), "default");
  const limiter = db.collection("emergencyRateLimits").doc(uid);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(limiter);
    const lastSentAt = snapshot.get("lastSentAt")?.toMillis?.() ?? 0;
    if (Date.now() - lastSentAt < emergencyCooldownMs) {
      throw new HttpsError("resource-exhausted", "Please wait before sending another emergency alert.");
    }
    transaction.set(limiter, { lastSentAt: new Date() });
  });

  const [nativeDevices, webDevices] = await Promise.all([
    db.collection("pushDevices").get(),
    db.collection("webPushDevices").get()
  ]);
  const nativeRecipients = nativeDevices.docs
    .filter(document => document.id !== uid && typeof document.get("token") === "string")
    .map(document => ({ reference: document.ref, token: document.get("token") }));
  const webSubscriptions = webDevices.docs.map(document => ({
    uid: document.id,
    reference: document.ref,
    endpoint: document.get("endpoint"),
    keys: document.get("keys")
  }));
  let webResult = { registered: 0, delivered: 0, stale: [] };
  if (webSubscriptions.some(device => device.uid !== uid)) {
    setVapidDetails("https://telsiz-app-88ecf.web.app", VAPID_PUBLIC_KEY, webPushPrivateKey.value());
    webResult = await deliverEmergencyWebPush({ devices: webSubscriptions, senderUid: uid, name });
  }

  let nativeResult = { successCount: 0, responses: [] };
  if (nativeRecipients.length) {
    nativeResult = await getMessaging(getApp()).sendEachForMulticast({
      tokens: nativeRecipients.map(recipient => recipient.token),
      notification: {
        title: "TELSİZ · ACİL DURUM",
        body: `${name} yardım çağrısı gönderdi.`
      },
      data: { kind: "emergency", sender: name },
      apns: { headers: { "apns-push-type": "alert", "apns-priority": "10" }, payload: { aps: { sound: "default", badge: 1 } } },
      android: { priority: "high", notification: { sound: "default" } }
    });
  }

  const staleNative = nativeResult.responses.flatMap((response, index) => {
    const code = response.error?.code;
    return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token"
      ? [nativeRecipients[index].reference]
      : [];
  });
  await Promise.all([...staleNative, ...webResult.stale].map(reference => reference.delete().catch(() => {})));
  const registered = nativeRecipients.length + webResult.registered;
  const delivered = nativeResult.successCount + webResult.delivered;
  logger.info("Emergency notification processed", { registered, delivered });
  return { registered, delivered };
});

export const getTurnCredentials = onCall({
  region: "europe-west3",
  secrets: [twilioAuthToken],
  maxInstances: 2
}, async request => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Anonymous sign-in is required.");
  const db = getFirestore(getApp(), "default");
  const cacheRef = db.collection("turnCredentials").doc(uid);
  const now = Date.now();
  const cached = await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(cacheRef);
    const expiresAt = snapshot.get("expiresAt")?.toMillis?.() ?? 0;
    if (expiresAt > now + 120_000) return snapshot.get("iceServers");
    return null;
  });
  if (Array.isArray(cached)) return { iceServers: cached };

  try {
    const iceServers = await createTurnCredentials({
      accountSid: twilioAccountSid.value(),
      authToken: twilioAuthToken.value()
    });
    await cacheRef.set({
      iceServers,
      expiresAt: new Date(now + 3_600_000),
      updatedAt: new Date()
    });
    return { iceServers };
  } catch (error) {
    logger.error("Failed to obtain managed TURN credentials", { message: error.message });
    throw new HttpsError("unavailable", "TURN credentials are unavailable.");
  }
});
