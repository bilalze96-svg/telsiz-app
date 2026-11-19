const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { defineSecret, defineString } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");
const { createRoomAccessToken } = require("./livekit-token");
const { moderateRoomMember, MAX_ROOM_MEMBERS } = require("./room-moderation");

initializeApp();

const LIVEKIT_API_KEY = defineSecret("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = defineSecret("LIVEKIT_API_SECRET");
const LIVEKIT_URL = defineString("LIVEKIT_URL");
const FIRESTORE_DATABASE_ID = "default";
const db = getFirestore(FIRESTORE_DATABASE_ID);
const REGION = "europe-west1";
const ROOM_ID_PATTERN = /^[A-Z0-9]{12}$/;

function requireAnonymousUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Firebase oturumu gerekli.");
  if (request.auth.token.firebase?.sign_in_provider !== "anonymous") {
    throw new HttpsError("permission-denied", "Yalnızca anonim Firebase oturumları kabul edilir.");
  }
  return request.auth.uid;
}

function requireRoomId(value) {
  if (typeof value !== "string" || !ROOM_ID_PATTERN.test(value)) {
    throw new HttpsError("invalid-argument", "Geçerli bir oda kodu gerekli.");
  }
  return value;
}

exports.moderateRoomMember = onCall({
  region: REGION,
  maxInstances: 20
}, async request => {
  const hostUid = requireAnonymousUser(request);
  const roomId = requireRoomId(request.data?.roomId);
  const memberUid = request.data?.memberUid;
  const decision = request.data?.decision;
  if (typeof memberUid !== "string" || memberUid.length > 128 || memberUid === hostUid) {
    throw new HttpsError("invalid-argument", "Geçerli bir katılımcı gerekli.");
  }
  if (decision !== "approved" && decision !== "rejected") {
    throw new HttpsError("invalid-argument", "İşlem onay veya ret olmalı.");
  }

  await moderateRoomMember({ db, roomId, hostUid, memberUid, decision });

  return { ok: true, decision };
});

exports.getRoomToken = onCall({
  region: REGION,
  maxInstances: 40,
  secrets: [LIVEKIT_API_KEY, LIVEKIT_API_SECRET]
}, async request => {
  const uid = requireAnonymousUser(request);
  const roomId = requireRoomId(request.data?.roomId);
  const roomRef = db.collection("rooms").doc(roomId);
  const memberRef = roomRef.collection("members").doc(uid);
  const [roomSnapshot, memberSnapshot, approvedSnapshot] = await Promise.all([
    roomRef.get(),
    memberRef.get(),
    roomRef.collection("members").where("status", "==", "approved").limit(MAX_ROOM_MEMBERS + 1).get()
  ]);

  if (!roomSnapshot.exists || roomSnapshot.data().status !== "open") {
    throw new HttpsError("failed-precondition", "Oda açık değil.");
  }
  if (!memberSnapshot.exists || memberSnapshot.data().status !== "approved") {
    throw new HttpsError("permission-denied", "Oda sahibinin onayı gerekli.");
  }
  if (approvedSnapshot.size > MAX_ROOM_MEMBERS) {
    throw new HttpsError("resource-exhausted", "Oda katılımcı sınırını aşıyor.");
  }

  const serverUrl = LIVEKIT_URL.value();
  if (!/^wss:\/\//.test(serverUrl)) {
    throw new HttpsError("failed-precondition", "LiveKit Cloud URL yapılandırılmamış.");
  }
  const token = await createRoomAccessToken(
    LIVEKIT_API_KEY.value(),
    LIVEKIT_API_SECRET.value(),
    roomId,
    uid
  );
  return { serverUrl, token };
});
