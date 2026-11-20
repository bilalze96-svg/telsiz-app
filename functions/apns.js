import { createSign } from "node:crypto";
import { connect } from "node:http2";

function base64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

export function createProviderToken({ keyId, teamId, privateKey, now = Date.now() }) {
  const header = base64url({ alg: "ES256", kid: keyId, typ: "JWT" });
  const claims = base64url({ iss: teamId, iat: Math.floor(now / 1000) });
  const signingInput = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

export function createPttPayload({ activeSpeaker, sessionId }) {
  return {
    activeSpeaker,
    speakerSession: sessionId,
    channel: "general"
  };
}

export function sendPttPush({ token, environment, bundleId, providerToken, payload, timeoutMs = 8000 }) {
  if (!/^[A-Fa-f0-9]{40,512}$/.test(token)) throw new Error("Invalid APNs device token");
  const origin = environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const session = connect(origin);

  return new Promise((resolve, reject) => {
    let response = "";
    let status = 0;
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${providerToken}`,
      "apns-topic": `${bundleId}.voip-ptt`,
      "apns-push-type": "pushtotalk",
      "apns-priority": "10",
      "apns-expiration": "0",
      "content-type": "application/json"
    });

    const timer = setTimeout(() => request.close(), timeoutMs);
    request.on("response", headers => { status = Number(headers[":status"] || 0); });
    request.setEncoding("utf8");
    request.on("data", chunk => { response += chunk; });
    request.on("end", () => {
      clearTimeout(timer);
      session.close();
      if (status >= 200 && status < 300) resolve({ status });
      else reject(Object.assign(new Error(`APNs rejected the push (${status}): ${response}`), { status, response }));
    });
    request.on("error", error => {
      clearTimeout(timer);
      session.destroy();
      reject(error);
    });
    request.end(JSON.stringify(payload));
  });
}
