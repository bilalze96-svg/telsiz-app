const { AccessToken, TrackSource } = require("livekit-server-sdk");

async function createRoomAccessToken(apiKey, apiSecret, roomId, uid) {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: uid,
    ttl: "5m"
  });
  token.addGrant({
    room: roomId,
    roomJoin: true,
    roomCreate: false,
    roomList: false,
    roomAdmin: false,
    roomRecord: false,
    ingressAdmin: false,
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE]
  });
  return token.toJwt();
}

module.exports = { createRoomAccessToken };
