import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import {
  collection, deleteDoc, doc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp,
  runTransaction, setDoc, Timestamp, updateDoc, where
} from "firebase/firestore";

const projectId = "telsiz-app-88ecf";
let testEnvironment;

function firestoreFor(uid) {
  return testEnvironment.authenticatedContext(uid, {
    firebase: { sign_in_provider: "anonymous" }
  }).firestore();
}

function memberRef(db, id) { return doc(db, "members", id); }
function inboxRef(db, targetId, signalId = "signal-123456") { return doc(db, "members", targetId, "inbox", signalId); }

async function seedMember(id, uid, lastSeen = serverTimestamp()) {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    await setDoc(memberRef(context.firestore(), id), {
      uid,
      name: uid,
      joinedAt: serverTimestamp(),
      lastSeen,
      talking: false
    });
  });
}

function signal(fromSession, fromUid, toSession, fields = {}) {
  return {
    fromSession,
    fromUid,
    toSession,
    kind: "offer",
    payload: JSON.stringify({ type: "offer", sdp: "example-sdp" }),
    createdAt: serverTimestamp(),
    ...fields
  };
}

before(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8")
    }
  });
});

beforeEach(async () => testEnvironment.clearFirestore());
after(async () => testEnvironment?.cleanup());

test("anonymous visitors can join the shared channel and see its roster", async () => {
  const db = firestoreFor("user-a");
  await assertSucceeds(setDoc(memberRef(db, "session-user-a"), {
    uid: "user-a", name: "Ece", joinedAt: serverTimestamp(), lastSeen: serverTimestamp(), talking: false
  }));
  const roster = await assertSucceeds(getDocs(query(collection(db, "members"), limit(10))));
  assert.equal(roster.size, 1);
  await assertSucceeds(updateDoc(memberRef(db, "session-user-a"), { talking: true, lastSeen: serverTimestamp() }));
});

test("nonanonymous users and forged or invalid member sessions are rejected", async () => {
  const anon = firestoreFor("user-a");
  const password = testEnvironment.authenticatedContext("password-user", {
    firebase: { sign_in_provider: "password" }
  }).firestore();
  const data = { uid: "user-a", name: "Ece", joinedAt: serverTimestamp(), lastSeen: serverTimestamp(), talking: false };
  await assertFails(setDoc(memberRef(password, "session-user-b"), data));
  await assertFails(setDoc(memberRef(anon, "short"), data));
  await assertFails(setDoc(memberRef(anon, "session-user-a"), { ...data, uid: "other-user" }));
  await assertFails(setDoc(memberRef(anon, "session-user-a"), { ...data, name: "" }));
  await assertFails(setDoc(memberRef(testEnvironment.unauthenticatedContext().firestore(), "session-user-c"), data));
});

test("a member can change only their own name and talk status", async () => {
  await seedMember("session-user-a", "user-a");
  const owner = firestoreFor("user-a");
  const other = firestoreFor("user-b");
  await assertSucceeds(updateDoc(memberRef(owner, "session-user-a"), {
    name: "Ece Yeni", lastSeen: serverTimestamp(), talking: true
  }));
  await assertFails(updateDoc(memberRef(owner, "session-user-a"), { uid: "user-b", lastSeen: serverTimestamp() }));
  await assertFails(updateDoc(memberRef(other, "session-user-a"), { talking: true, lastSeen: serverTimestamp() }));
  await assertSucceeds(deleteDoc(memberRef(owner, "session-user-a")));
});

test("members can signal another live session, and only the recipient can read it", async () => {
  await seedMember("session-user-a", "user-a");
  await seedMember("session-user-b", "user-b");
  const sender = firestoreFor("user-a");
  const recipient = firestoreFor("user-b");
  const outsider = firestoreFor("user-c");
  await assertSucceeds(setDoc(inboxRef(sender, "session-user-b"), signal("session-user-a", "user-a", "session-user-b")));
  await assertSucceeds(getDocs(collection(recipient, "members", "session-user-b", "inbox")));
  await assertFails(getDocs(collection(sender, "members", "session-user-b", "inbox")));
  await assertFails(getDocs(collection(outsider, "members", "session-user-b", "inbox")));
  await assertSucceeds(deleteDoc(inboxRef(recipient, "session-user-b")));
});

test("signaling cannot impersonate another sender, target a nonexistent session, or exceed payload limits", async () => {
  await seedMember("session-user-a", "user-a");
  await seedMember("session-user-b", "user-b");
  const sender = firestoreFor("user-a");
  await assertFails(setDoc(inboxRef(sender, "session-user-b"), signal("session-user-x", "user-a", "session-user-b")));
  await assertFails(setDoc(inboxRef(sender, "session-missing"), signal("session-user-a", "user-a", "session-missing")));
  await assertFails(setDoc(inboxRef(sender, "session-user-b"), signal("session-user-a", "user-a", "session-user-b", { payload: "x".repeat(12001) })));
});

test("other anonymous visitors can remove expired sessions but not active ones", async () => {
  await seedMember("session-expired", "user-a", Timestamp.fromMillis(Date.now() - 120_000));
  await seedMember("session-current", "user-b");
  const cleaner = firestoreFor("user-c");
  await assertSucceeds(deleteDoc(memberRef(cleaner, "session-expired")));
  await assertFails(deleteDoc(memberRef(cleaner, "session-current")));
});

test("only the owner can register a valid Apple PTT token for their live session", async () => {
  await seedMember("session-user-a", "user-a");
  const owner = firestoreFor("user-a");
  const other = firestoreFor("user-b");
  const token = doc(owner, "pttTokens", "user-a");
  const tokenData = {
    uid: "user-a",
    sessionId: "session-user-a",
    token: "a".repeat(64),
    environment: "sandbox",
    updatedAt: serverTimestamp()
  };
  await assertSucceeds(setDoc(token, tokenData));
  await assertFails(setDoc(doc(other, "pttTokens", "user-a"), tokenData));
  await assertFails(setDoc(doc(owner, "pttTokens", "user-a"), { ...tokenData, token: "not-a-device-token" }));
  await assertFails(getDocs(collection(owner, "pttTokens")));
  await assertSucceeds(deleteDoc(token));
});

test("a returning anonymous user can register one private emergency notification token", async () => {
  const owner = firestoreFor("user-a");
  const other = firestoreFor("user-b");
  const token = doc(owner, "pushDevices", "user-a");
  const tokenData = { uid: "user-a", token: "fcm-token-" + "x".repeat(100), updatedAt: serverTimestamp() };
  await assertSucceeds(setDoc(token, tokenData));
  await assertSucceeds(setDoc(token, { ...tokenData, token: "refreshed-fcm-token-" + "y".repeat(100) }));
  await assertFails(setDoc(doc(other, "pushDevices", "user-a"), tokenData));
  await assertFails(setDoc(doc(owner, "pushDevices", "user-a"), { ...tokenData, uid: "user-b" }));
  await assertFails(getDocs(collection(owner, "pushDevices")));
  await assertSucceeds(deleteDoc(token));
});

test("only an anonymous device owner can register a valid private web push subscription", async () => {
  const owner = firestoreFor("user-a");
  const other = firestoreFor("user-b");
  const subscription = doc(owner, "webPushDevices", "user-a");
  const data = {
    uid: "user-a",
    endpoint: "https://push.example.com/" + "e".repeat(80),
    keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) },
    updatedAt: serverTimestamp()
  };
  await assertSucceeds(setDoc(subscription, data));
  await assertSucceeds(setDoc(subscription, { ...data, endpoint: "https://push.example.com/" + "f".repeat(80) }));
  await assertFails(setDoc(doc(other, "webPushDevices", "user-a"), data));
  await assertFails(setDoc(subscription, { ...data, uid: "user-b" }));
  await assertFails(setDoc(subscription, { ...data, endpoint: "http://push.example.com/subscription" }));
  await assertFails(setDoc(subscription, { ...data, keys: { p256dh: "short", auth: "a".repeat(22) } }));
  await assertFails(getDocs(collection(owner, "webPushDevices")));
  await assertSucceeds(deleteDoc(subscription));
});

test("emergency alerts reach open clients and require a two-minute owner cooldown", async () => {
  const owner = firestoreFor("user-a");
  const recipient = firestoreFor("user-b");
  const rateLimit = doc(owner, "emergencyWebRateLimits", "user-a");
  const alert = doc(collection(owner, "emergencyAlerts"));
  await assertFails(setDoc(alert, { uid: "user-a", name: "Ece", createdAt: serverTimestamp() }));
  await assertSucceeds(runTransaction(owner, async transaction => {
    await transaction.get(rateLimit);
    transaction.set(rateLimit, { uid: "user-a", lastSentAt: serverTimestamp() });
    transaction.set(alert, { uid: "user-a", name: "Ece", createdAt: serverTimestamp() });
  }));
  const alerts = await assertSucceeds(getDocs(collection(recipient, "emergencyAlerts")));
  assert.equal(alerts.size, 1);
  const nextAlert = doc(collection(owner, "emergencyAlerts"));
  await assertFails(runTransaction(owner, async transaction => {
    await transaction.get(rateLimit);
    transaction.set(rateLimit, { uid: "user-a", lastSentAt: serverTimestamp() });
    transaction.set(nextAlert, { uid: "user-a", name: "Ece", createdAt: serverTimestamp() });
  }));
  await assertFails(setDoc(doc(recipient, "emergencyWebRateLimits", "user-a"), {
    uid: "user-a", lastSentAt: serverTimestamp()
  }));
});

test("an active recipient receives the alert as a realtime Firestore update", async () => {
  const owner = firestoreFor("user-a");
  const recipient = firestoreFor("user-b");
  const rateLimit = doc(owner, "emergencyWebRateLimits", "user-a");
  const alert = doc(collection(owner, "emergencyAlerts"));
  const alerts = query(
    collection(recipient, "emergencyAlerts"),
    where("createdAt", ">", Timestamp.fromMillis(Date.now() - 86_400_000)),
    orderBy("createdAt", "desc"),
    limit(30)
  );

  let initialSnapshotResolve;
  let alertResolve;
  let unsubscribe;
  const initialSnapshot = new Promise(resolve => { initialSnapshotResolve = resolve; });
  const receivedAlert = new Promise(resolve => { alertResolve = resolve; });
  let initialized = false;
  unsubscribe = onSnapshot(alerts, snapshot => {
    if (!initialized) {
      initialized = true;
      initialSnapshotResolve();
      return;
    }
    const added = snapshot.docChanges().find(change => change.type === "added");
    if (added) alertResolve(added.doc.data());
  });

  try {
    await initialSnapshot;
    await runTransaction(owner, async transaction => {
      await transaction.get(rateLimit);
      transaction.set(rateLimit, { uid: "user-a", lastSentAt: serverTimestamp() });
      transaction.set(alert, { uid: "user-a", name: "Ece", createdAt: serverTimestamp() });
    });
    const result = await Promise.race([
      receivedAlert,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Live alert did not reach the subscriber")), 3000))
    ]);
    assert.equal(result.uid, "user-a");
    assert.equal(result.name, "Ece");
  } finally {
    unsubscribe();
  }
});

test("short-lived server-side TURN credentials cannot be read or changed by clients", async () => {
  const owner = firestoreFor("user-a");
  await assertFails(getDocs(collection(owner, "turnCredentials")));
  await assertFails(setDoc(doc(owner, "turnCredentials", "user-a"), {
    iceServers: [{ urls: "turn:example.invalid" }], expiresAt: Timestamp.fromMillis(Date.now() + 3600_000)
  }));
});
