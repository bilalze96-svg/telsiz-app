export async function createTurnCredentials({ accountSid, authToken, fetchImpl = fetch }) {
  if (!/^AC[a-fA-F0-9]{32}$/.test(accountSid) || typeof authToken !== "string" || !authToken) {
    throw new Error("Twilio Network Traversal credentials are not configured.");
  }

  const basic = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ Ttl: "3600" }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`Twilio rejected TURN credential request (${response.status}).`);

  const body = await response.json();
  if (!Array.isArray(body.ice_servers) || body.ice_servers.length === 0) {
    throw new Error("Twilio response did not contain ICE servers.");
  }
  return body.ice_servers.filter(server => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some(url => typeof url === "string" && /^(stun|turn):/.test(url));
  });
}
