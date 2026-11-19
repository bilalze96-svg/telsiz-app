const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRoomAccessToken } = require("../livekit-token");

test("room token is short-lived and permits only microphone publishing and listening", async () => {
  const token = await createRoomAccessToken(
    "TEST_ONLY_API_KEY",
    "TEST_ONLY_SECRET_NOT_FOR_DEPLOYMENT",
    "ABCDEF123456",
    "anonymous-user-id"
  );
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

  assert.equal(claims.sub, "anonymous-user-id");
  assert.equal(claims.video.room, "ABCDEF123456");
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.deepEqual(claims.video.canPublishSources, ["microphone"]);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(claims.video.roomCreate, false);
  assert.equal(claims.video.roomList, false);
  assert.equal(claims.video.roomAdmin, false);
  assert.equal(claims.video.roomRecord, false);
  assert.equal(claims.video.ingressAdmin, false);
  assert.equal(claims.name, undefined);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.exp > now);
  assert.ok(claims.exp - now <= 300);
});
