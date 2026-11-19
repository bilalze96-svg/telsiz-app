const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { moderateRoomMember } = require("../room-moderation");

const projectId = "telsiz-app-88ecf";
const roomId = "MODTEST00001";
let app;
let db;
let roomRef;

before(() => {
  app = initializeApp({ projectId }, `room-moderation-test-${process.pid}`);
  db = getFirestore(app);
  roomRef = db.collection("rooms").doc(roomId);
});

after(async () => {
  if (roomRef) {
    const members = await roomRef.collection("members").get();
    const batch = db.batch();
    members.docs.forEach(member => batch.delete(member.ref));
    batch.delete(roomRef);
    await batch.commit();
  }
  if (app) await deleteApp(app);
});

test("concurrent approvals cannot exceed the ten-member limit", async () => {
  await roomRef.set({ hostUid: "host", status: "open" });
  const members = roomRef.collection("members");
  const batch = db.batch();
  for (let index = 0; index < 9; index++) {
    batch.set(members.doc(`approved-${index}`), {
      name: `Member ${index}`,
      status: "approved",
      joinedAt: FieldValue.serverTimestamp()
    });
  }
  for (const uid of ["pending-a", "pending-b"]) {
    batch.set(members.doc(uid), {
      name: uid,
      status: "pending",
      joinedAt: FieldValue.serverTimestamp()
    });
  }
  await batch.commit();

  const results = await Promise.allSettled(["pending-a", "pending-b"].map(memberUid =>
    moderateRoomMember({ db, roomId, hostUid: "host", memberUid, decision: "approved" })
  ));

  assert.equal(
    results.filter(result => result.status === "fulfilled").length,
    1,
    JSON.stringify(results.map(result => result.status === "rejected"
      ? { code: result.reason.code, message: result.reason.message }
      : { status: result.status }))
  );
  const rejected = results.find(result => result.status === "rejected");
  assert.equal(rejected.reason.code, "resource-exhausted");
  const approved = await members.where("status", "==", "approved").get();
  assert.equal(approved.size, 10);
  assert.equal((await roomRef.get()).data().moderationRevision, 1);
});
