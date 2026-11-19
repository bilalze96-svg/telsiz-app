import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// Firebase web config: public client identifiers, protected by Firestore Security Rules.
const firebaseConfig = {
  apiKey: "AIzaSyDdXDYDxwbLn3BhnQGxJzhsQnKc0TP1EM",
  authDomain: "telsiz-app-88ecf.firebaseapp.com",
  projectId: "telsiz-app-88ecf",
  storageBucket: "telsiz-app-88ecf.firebasestorage.app",
  messagingSenderId: "217716786139",
  appId: "1:217716786139:web:0d7bf957bf2f5afa031dfe"
};

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const invite = params.get("room");
const appInstance = initializeApp(firebaseConfig);
const auth = getAuth(appInstance);
const db = getFirestore(appInstance);
const rtcConfig = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }] };

let user = null, roomId = "", displayName = "", isHost = false, localStream = null;
let unsubscribers = [], unsubSignals = null, peers = new Map(), memberCache = new Map(), active = false;

function message(id, text) { $(id).textContent = text; }
function setRoomState(text) { $("roomState").textContent = text; }
function roomRef() { return doc(db, "rooms", roomId); }
function membersRef() { return collection(db, "rooms", roomId, "members"); }
function memberRef(uid = user.uid) { return doc(db, "rooms", roomId, "members", uid); }
function signalsRef() { return collection(db, "rooms", roomId, "signals"); }
function cleanName(value) { return value.trim().replace(/[<>]/g, "").slice(0, 24); }

function stopListeners() {
  unsubscribers.forEach(fn => fn());
  unsubscribers = [];
  if (unsubSignals) { unsubSignals(); unsubSignals = null; }
}
async function closePeers() {
  for (const [, pc] of peers) pc.close();
  peers.clear();
}
function renderPeople() {
  const list = [...memberCache.values()].filter(m => m.status === "approved");
  $("people").replaceChildren();
  list.forEach(m => {
    const li = document.createElement("li");
    const name = document.createElement("span"); name.textContent = m.name || "Katılımcı";
    const state = document.createElement("span"); state.className = "person-state";
    state.textContent = m.uid === user.uid ? "Bu cihaz" : "Bağlı";
    li.append(name, state); $("people").append(li);
  });
  $("peopleCount").textContent = list.length + " kişi";
}
function renderRequests() {
  const box = $("requests");
  box.replaceChildren();
  [...memberCache.values()].filter(m => m.status === "pending").forEach(m => {
    const li = document.createElement("li");
    const name = document.createElement("span"); name.textContent = m.name || "Misafir";
    const actions = document.createElement("span");
    const approve = document.createElement("button"); approve.className = "copy"; approve.textContent = "Onayla";
    approve.addEventListener("click", () => approveMember(m.uid));
    const reject = document.createElement("button"); reject.className = "danger"; reject.textContent = "Reddet";
    reject.addEventListener("click", () => rejectMember(m.uid));
    actions.append(approve, reject); li.append(name, actions); box.append(li);
  });
}
function renderRoom() {
  renderPeople();
  if (isHost) renderRequests();
}
function showRoom() {
  $("welcome").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomName").textContent = "EKİP ODASI";
  $("inviteText").textContent = location.origin + location.pathname + "?room=" + roomId;
  $("closeRoom").classList.toggle("hidden", !isHost);
  $("requestsBox").classList.toggle("hidden", !isHost);
  $("talkButton").disabled = false;
  $("talkButton").querySelector("small").textContent = "Basılı tutarak konuş";
  $("muteButton").disabled = false;
}
async function approveMember(uid) {
  try {
    await updateDoc(memberRef(uid), { status: "approved", approvedAt: serverTimestamp() });
    message("roomMsg", "Katılımcı onaylandı.");
  } catch (e) { message("roomMsg", "Onay başarısız: " + e.message); }
}
async function rejectMember(uid) {
  try { await deleteDoc(memberRef(uid)); message("roomMsg", "Katılma isteği reddedildi."); }
  catch (e) { message("roomMsg", "İstek silinemedi: " + e.message); }
}
async function sendSignal(to, type, payload) {
  await addDoc(signalsRef(), { from: user.uid, to, type, payload, createdAt: serverTimestamp() });
}
function makePeer(remoteUid) {
  if (peers.has(remoteUid)) return peers.get(remoteUid);
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(remoteUid, pc);
  const audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
  pc._audioSender = audioTransceiver.sender;
  if (localStream) audioTransceiver.sender.replaceTrack(localStream.getAudioTracks()[0]).catch(console.error);
  pc.onicecandidate = e => { if (e.candidate) sendSignal(remoteUid, "candidate", e.candidate.toJSON()).catch(console.error); };
  pc.ontrack = e => {
    let audio = document.getElementById("audio-" + remoteUid);
    if (!audio) { audio = document.createElement("audio"); audio.id = "audio-" + remoteUid; audio.autoplay = true; audio.playsInline = true; document.body.append(audio); }
    audio.srcObject = e.streams[0];
    audio.play().catch(() => message("roomMsg", "Sesi duymak için ekrana dokunup oynatmayı etkinleştirin."));
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      const audio = document.getElementById("audio-" + remoteUid); if (audio) audio.remove();
      if (pc.connectionState === "failed") message("roomMsg", "Bir ses bağlantısı kurulamadı. Ağınız TURN sunucusu gerektiriyor olabilir.");
    }
  };
  pc.onnegotiationneeded = async () => {
    if (user.uid.localeCompare(remoteUid) > 0) return;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await sendSignal(remoteUid, "description", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
    } catch (e) { console.error("WebRTC negotiation", e); }
  };
  return pc;
}
async function handleSignal(signal) {
  if (!memberCache.has(signal.from) || memberCache.get(signal.from).status !== "approved") return;
  const pc = makePeer(signal.from);
  try {
    if (signal.type === "description") {
      await pc.setRemoteDescription(signal.payload);
      if (signal.payload.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        await sendSignal(signal.from, "description", { type: pc.localDescription.type, sdp: pc.localDescription.sdp });
      }
    } else if (signal.type === "candidate" && signal.payload) {
      await pc.addIceCandidate(signal.payload);
    }
  } catch (e) { console.error("Signal handling", e); }
}
function startRoomListeners() {
  stopListeners();
  unsubscribers.push(onSnapshot(membersRef(), snap => {
    memberCache.clear();
    snap.forEach(d => memberCache.set(d.id, { uid: d.id, ...d.data() }));
    renderRoom();
    if (memberCache.get(user.uid)?.status !== "approved") {
      $("talkButton").disabled = true;
      setRoomState("ONAY BEKLENİYOR");
      message("roomMsg", "Oda sahibinin katılma isteğinizi onaylaması bekleniyor.");
      return;
    }
    setRoomState("BAĞLI");
    if (!unsubSignals) {
      const incoming = query(signalsRef(), where("to", "==", user.uid), limit(100));
      unsubSignals = onSnapshot(incoming, snap => {
        snap.docChanges().forEach(change => {
          if (change.type === "added") {
            const data = change.doc.data();
            handleSignal(data).finally(() => deleteDoc(change.doc.ref).catch(() => {}));
          }
        });
      }, e => message("roomMsg", "Ses sinyalleşmesi okunamadı: " + e.message));
    }
    for (const [uid, m] of memberCache) {
      if (uid !== user.uid && m.status === "approved") makePeer(uid);
    }
    for (const [uid, pc] of peers) {
      if (!memberCache.has(uid) || memberCache.get(uid).status !== "approved") {
        pc.close(); peers.delete(uid);
        const audio = document.getElementById("audio-" + uid); if (audio) audio.remove();
      }
    }
  }, e => message("roomMsg", "Katılımcılar okunamadı: " + e.message)));
  unsubscribers.push(onSnapshot(roomRef(), snap => {
    if (!snap.exists() || snap.data().status === "closed") {
      message("roomMsg", "Oda sahibi odayı kapattı.");
      cleanup(false);
      location.href = location.pathname;
    }
  }));
}
async function cleanup(redirect = true) {
  active = false; stopListeners(); await closePeers();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  document.querySelectorAll("audio[id^='audio-']").forEach(a => a.remove());
  if (redirect) location.href = location.pathname;
}
async function createRoom() {
  displayName = cleanName($("displayName").value);
  if (!displayName) return message("welcomeMsg", "Önce görünen adını yaz.");
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  roomId = id; isHost = true;
  try {
    await setDoc(roomRef(), { hostUid: user.uid, status: "open", createdAt: serverTimestamp(), title: "EKİP ODASI" });
    await setDoc(memberRef(), { name: displayName, status: "approved", joinedAt: serverTimestamp() });
    active = true; history.replaceState({}, "", "?room=" + id); showRoom(); startRoomListeners();
    setRoomState("ODA AÇIK"); message("roomMsg", "Oda oluşturuldu. Davet bağlantısını ekibinle paylaşabilirsin.");
  } catch (e) { message("welcomeMsg", "Oda oluşturulamadı: " + e.message); }
}
async function requestJoin() {
  displayName = cleanName($("displayName").value);
  const id = ($("inviteCode").value.trim().toUpperCase() || invite || "").replace(/[^A-Z0-9]/g, "");
  if (!displayName) return message("welcomeMsg", "Önce görünen adını yaz.");
  if (!id) return message("welcomeMsg", "Davet kodunu veya bağlantısını gir.");
  roomId = id; isHost = false;
  try {
    const room = await getDoc(roomRef());
    if (!room.exists() || room.data().status !== "open") return message("welcomeMsg", "Bu oda bulunamadı veya kapatılmış.");
    await setDoc(memberRef(), { name: displayName, status: "pending", joinedAt: serverTimestamp() });
    active = true; showRoom(); history.replaceState({}, "", "?room=" + id); startRoomListeners();
    setRoomState("ONAY BEKLENİYOR");
    message("roomMsg", "Katılma isteğin oda sahibine gönderildi.");
  } catch (e) { message("welcomeMsg", "Katılma isteği gönderilemedi: " + e.message); }
}
async function startTalking() {
  if (!active || $("talkButton").disabled) return;
  if (!localStream) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      localStream.getTracks().forEach(track => { track.enabled = true; });
      for (const [, pc] of peers) if (pc._audioSender) await pc._audioSender.replaceTrack(localStream.getAudioTracks()[0]);
    } catch (e) { return message("roomMsg", "Mikrofon açılamadı. HTTPS ve mikrofon iznini kontrol edin: " + e.message); }
  }
  localStream.getAudioTracks().forEach(t => t.enabled = true);
  $("talkButton").classList.add("active");
  $("talkButton").querySelector("small").textContent = "KONUŞUYORSUN";
}
function stopTalking() {
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
  $("talkButton").classList.remove("active");
  $("talkButton").querySelector("small").textContent = "Basılı tutarak konuş";
}
async function closeRoom() {
  if (!isHost) return;
  try { await updateDoc(roomRef(), { status: "closed", closedAt: serverTimestamp() }); }
  catch (e) { message("roomMsg", "Oda kapatılamadı: " + e.message); return; }
  await cleanup();
}
$("createRoom").addEventListener("click", createRoom);
$("requestJoin").addEventListener("click", requestJoin);
$("copyInvite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("inviteText").textContent); $("copyInvite").textContent = "KOPYALANDI"; }
  catch { message("roomMsg", "Bağlantı kopyalanamadı; adres çubuğundan kopyalayın."); }
});
$("leaveButton").addEventListener("click", () => cleanup());
$("closeRoom").addEventListener("click", closeRoom);
$("muteButton").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0]; track.enabled = !track.enabled;
  $("muteButton").textContent = track.enabled ? "Mikrofonu kapat" : "Mikrofonu aç";
});
$("talkButton").addEventListener("pointerdown", e => { e.preventDefault(); startTalking(); });
["pointerup", "pointercancel", "pointerleave"].forEach(evt => $("talkButton").addEventListener(evt, stopTalking));
document.addEventListener("visibilitychange", () => { if (document.hidden) stopTalking(); });
if (invite) $("inviteCode").value = invite;

(async () => {
  try {
    const credential = await signInAnonymously(auth);
    user = credential.user;
    if (invite) $("inviteCode").value = invite;
    const paramsRoom = invite;
    if (paramsRoom) {
      // Show the invite code but wait for an explicit join request.
      $("inviteCode").value = paramsRoom;
    }
    message("welcomeMsg", "Bağlantı hazır. Bir oda oluştur veya davet koduyla katıl.");
  } catch (e) {
    message("welcomeMsg", "Firebase kimlik doğrulaması başarısız: " + e.message);
    $("createRoom").disabled = true; $("requestJoin").disabled = true;
  }
})();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
