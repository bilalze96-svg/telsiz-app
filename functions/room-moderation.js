const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { HttpsError } = require("firebase-functions/v2/https");

const MAX_ROOM_MEMBERS = 10;

async function moderateRoomMember({
  db = getFirestore(),
  roomId,
  hostUid,
  memberUid,
  decision
}) {
  const roomRef = db.collection("rooms").doc(roomId);
  const members = roomRef.collection("members");
  const targetRef = members.doc(memberUid);

  await db.runTransaction(async transaction => {
    const roomSnapshot = await transaction.get(roomRef);
    const targetSnapshot = await transaction.get(targetRef);
    const approvedSnapshot = decision === "approved"
      ? await transaction.get(members.where("status", "==", "approved").limit(MAX_ROOM_MEMBERS))
      : null;

    if (!roomSnapshot.exists || roomSnapshot.data().status !== "open") {
      throw new HttpsError("failed-precondition", "Oda açık değil.");
    }
    if (roomSnapshot.data().hostUid !== hostUid) {
      throw new HttpsError("permission-denied", "Bu işlem yalnızca oda sahibine açık.");
    }
    if (!targetSnapshot.exists || targetSnapshot.data().status !== "pending") {
      throw new HttpsError("failed-precondition", "Bekleyen bir katılma isteği bulunamadı.");
    }
    if (decision === "approved" && approvedSnapshot.size >= MAX_ROOM_MEMBERS) {
      throw new HttpsError("resource-exhausted", "Oda en fazla 10 katılımcı alabilir.");
    }

    // Serialize moderation transactions through the room document so two
    // simultaneous approvals cannot both claim the final seat.
    transaction.update(roomRef, { moderationRevision: FieldValue.increment(1) });
    const update = {
      status: decision,
      reviewedAt: FieldValue.serverTimestamp()
    };
    if (decision === "approved") update.approvedAt = FieldValue.serverTimestamp();
    transaction.update(targetRef, update);
  });
}

module.exports = { moderateRoomMember, MAX_ROOM_MEMBERS };
