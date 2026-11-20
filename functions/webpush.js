import { sendNotification } from "web-push";

export const VAPID_PUBLIC_KEY = "BI0-TW2JrpTf2nd19YWPg7bIV0YnI0qiXMMvfOHiLkk2n1sH6joC2P1eGluD3LCnCmMLmmd-zGdV4QvIbTay3hA";

export function createEmergencyWebPush(name) {
  return {
    title: "TELSİZ · ACİL DURUM",
    body: `${name} yardım çağrısı gönderdi.`,
    tag: "telsiz-emergency",
    url: "/"
  };
}

export async function deliverEmergencyWebPush({ devices, senderUid, name, send = sendNotification }) {
  const recipients = devices
    .filter(device => device.uid !== senderUid &&
      typeof device.endpoint === "string" &&
      device.keys && typeof device.keys.p256dh === "string" && typeof device.keys.auth === "string")
    .map(device => ({
      reference: device.reference,
      subscription: { endpoint: device.endpoint, keys: device.keys }
    }));
  const payload = JSON.stringify(createEmergencyWebPush(name));
  const responses = await Promise.allSettled(recipients.map(({ subscription }) => send(subscription, payload, { TTL: 60 })));
  const stale = responses.flatMap((response, index) => {
    const status = response.status === "rejected" ? response.reason?.statusCode : 0;
    return [404, 410].includes(status) ? [recipients[index].reference] : [];
  });
  return {
    registered: recipients.length,
    delivered: responses.filter(response => response.status === "fulfilled").length,
    stale
  };
}
