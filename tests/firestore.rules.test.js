import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "firebase/firestore";

const projectId = "telsiz-app-88ecf";
const roomId = "ABCDEF123456";
let testEnvironment;

function firestoreFor(uid) {
  return testEnvironment.authenticatedContext(uid, {
    firebase: { sign_in_provider: "anonymous" }
  }).firestore();
}

function roomDocument(db, id = roomId) {
  return doc(db, "rooms", id);
}

function memberDocument(db, uid, id = roomId) {
  return doc(db, "rooms", id, "members", uid);
}

async function seedRoom(members = []) {
  await testEnvironment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(roomDocument(db), {
      hostUid: "host",
      status: "open",
      createdAt: serverTimestamp(),
      title: "EKİP ODASI"
    });
    for (const member of members) {
      await setDoc(memberDocument(db, member.uid), {
        name: member.name || member.uid,
        status: member.status,
        joinedAt: serverTimestamp()
      });
    }
  });
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

test("room owner can create an open room and approved owner membership", async () => {
  const db = firestoreFor("host");
  await assertSucceeds(setDoc(roomDocument(db), {
    hostUid: "host",
    status: "open",
    createdAt: serverTimestamp(),
    title: "EKİP ODASI"
  }));
  await assertSucceeds(setDoc(memberDocument(db, "host"), {
    name: "Oda sahibi",
    status: "approved",
    joinedAt: serverTimestamp()
  }));
});

test("room creation rejects nonanonymous users, invalid IDs, and extra fields", async () => {
  const anonymousDb = firestoreFor("host");
  const passwordDb = testEnvironment.authenticatedContext("password-user", {
    firebase: { sign_in_provider: "password" }
  }).firestore();
  const roomData = {
    hostUid: "host",
    status: "open",
    createdAt: serverTimestamp(),
    title: "EKİP ODASI"
  };

  await assertFails(setDoc(roomDocument(passwordDb), roomData));
  await assertFails(setDoc(roomDocument(anonymousDb, "short"), roomData));
  await assertFails(setDoc(roomDocument(anonymousDb), { ...roomData, isAdmin: true }));
  await assertFails(setDoc(roomDocument(anonymousDb), { ...roomData, hostUid: "other" }));
});

test("invitee can read an open room and submit only their own pending request", async () => {
  await seedRoom([{ uid: "host", status: "approved" }]);
  const invitee = firestoreFor("invitee");
  await assertSucceeds(getDoc(roomDocument(invitee)));
  await assertSucceeds(setDoc(memberDocument(invitee, "invitee"), {
    name: "Misafir",
    status: "pending",
    joinedAt: serverTimestamp()
  }));

  await assertFails(setDoc(memberDocument(invitee, "other-user"), {
    name: "Başka kullanıcı",
    status: "pending",
    joinedAt: serverTimestamp()
  }));
  const otherInvitee = firestoreFor("second");
  await assertFails(setDoc(memberDocument(otherInvitee, "second"), {
    name: "Yetkisiz onay",
    status: "approved",
    joinedAt: serverTimestamp()
  }));
});

test("pending members can read their request but cannot list or inspect the roster", async () => {
  await seedRoom([
    { uid: "host", status: "approved" },
    { uid: "invitee", status: "pending" }
  ]);
  const invitee = firestoreFor("invitee");
  await assertSucceeds(getDoc(memberDocument(invitee, "invitee")));
  await assertFails(getDoc(memberDocument(invitee, "host")));
  await assertFails(getDocs(collection(invitee, "rooms", roomId, "members")));
});

test("approved members can query approved roster rows while pending rows remain private", async () => {
  await seedRoom([
    { uid: "host", status: "approved" },
    { uid: "approved", status: "approved" },
    { uid: "pending", status: "pending" }
  ]);
  const approved = firestoreFor("approved");
  const host = firestoreFor("host");
  const members = collection(approved, "rooms", roomId, "members");
  const approvedRows = await assertSucceeds(getDocs(query(members, where("status", "==", "approved"))));
  assert.equal(approvedRows.size, 2);
  await assertFails(getDocs(members));
  await assertFails(getDoc(memberDocument(approved, "pending")));
  const hostRows = await assertSucceeds(getDocs(collection(host, "rooms", roomId, "members")));
  assert.equal(hostRows.size, 3);
});

test("only the moderation function can approve or reject a pending member", async () => {
  await seedRoom([
    { uid: "host", status: "approved" },
    { uid: "invitee", status: "pending" }
  ]);
  const host = firestoreFor("host");
  await assertFails(updateDoc(memberDocument(host, "invitee"), {
    status: "approved",
    approvedAt: serverTimestamp()
  }));
  await assertFails(updateDoc(memberDocument(host, "invitee"), { status: "rejected" }));
});

test("host can close an open room, while other room and membership mutations are denied", async () => {
  await seedRoom([
    { uid: "host", status: "approved" },
    { uid: "invitee", status: "pending" }
  ]);
  const host = firestoreFor("host");
  const invitee = firestoreFor("invitee");

  await assertFails(updateDoc(roomDocument(invitee), {
    status: "closed",
    closedAt: serverTimestamp()
  }));
  await assertFails(deleteDoc(roomDocument(host)));
  await assertFails(setDoc(doc(host, "rooms", roomId, "signals", "signal"), {
    from: "host", to: "invitee", type: "offer", payload: "raw-sdp"
  }));
  await assertSucceeds(updateDoc(roomDocument(host), {
    status: "closed",
    closedAt: serverTimestamp()
  }));
  await assertSucceeds(getDoc(roomDocument(invitee)));
  await assertSucceeds(deleteDoc(memberDocument(invitee, "invitee")));
});
