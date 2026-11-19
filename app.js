import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  addDoc, collection, deleteDoc, doc, getDocs, getFirestore, limit, onSnapshot,
  query, serverTimestamp, setDoc, Timestamp, updateDoc, where
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDdXDYDxwbLn3BhnNQGxJzhsQnKc0TP1EM",
  authDomain: "telsiz-app-88ecf.firebaseapp.com",
  projectId: "telsiz-app-88ecf",
  storageBucket: "telsiz-app-88ecf.firebasestorage.app",
  messagingSenderId: "217716786139",
  appId: "1:217716786139:web:0d7bf957bf2f5afa031dfe"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app, "default");
const members = collection(db, "members");
const MAX_PEOPLE = 10;
const STALE_MS = 45_000;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const $ = id => document.getElementById(id);

let user = null;
let sessionId = "";
let ownMemberRef = null;
let localStream = null;
let localTrack = null;
let talking = false;
let memberCache = new Map();
let peers = new Map();
let bufferedSignals = new Map();
let membersUnsubscribe = null;
let inboxUnsubscribe = null;
let heartbeatTimer = null;
let joined = false;
let channelSnapshotInitialized = false;
let talkToastTimer = null;

function say(id, text) { $(id).textContent = text; }
function validName(value) { return value.trim().replace(/[<>]/g, "").replace(/\s+/g, " ").slice(0, 24); }
function sessionRef(id) { return doc(db, "members", id); }
function inboxRef(id) { return collection(db, "members", id, "inbox"); }
function announceTalkers(names) {
  const toast = $("talkToast");
  const message = names.length === 1
    ? `${names[0]} konuşmaya başladı`
    : `${names.join(", ")} konuşmaya başladı`;
  toast.textContent = `📻 ${message}`;
  toast.classList.remove("hidden");
  clearTimeout(talkToastTimer);
  talkToastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
  if (typeof navigator.vibrate === "function") navigator.vibrate(120);
}

function notifyNewTalkers(previous, current) {
  const names = [...current.entries()]
    .filter(([id, member]) => id !== sessionId && isFresh(member) && member.talking && !previous.get(id)?.talking)
    .map(([, member]) => member.name);
  if (names.length) announceTalkers(names);
}

function isFresh(member) {
  const seenAt = member.lastSeen?.toDate?.().getTime();
  return Number.isFinite(seenAt) && Date.now() - seenAt < STALE_MS;
}

function renderMembers() {
  const online = [...memberCache.entries()]
    .filter(([, member]) => isFresh(member))
    .sort((a, b) => a[1].joinedAt?.toMillis?.() - b[1].joinedAt?.toMillis?.());
  const list = $("peopleList");
  list.replaceChildren();
  for (const [id, member] of online) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = id === sessionId ? `${member.name} (sen)` : member.name;
    const state = document.createElement("span");
    state.className = `person-state ${member.talking ? "on-air" : ""}`;
    state.textContent = member.talking ? "KONUŞUYOR" : id === sessionId ? "BAĞLI" : peers.get(id)?.connected ? "BAĞLI" : "BAĞLANIYOR";
    row.append(name, state);
    list.append(row);
  }
  $("peopleCount").textContent = `${online.length}/${MAX_PEOPLE}`;
  const speakers = online.filter(([, member]) => member.talking).map(([, member]) => member.name);
  $("speakerBanner").classList.toggle("hidden", speakers.length === 0);
  say("speakerName", speakers.length ? `${speakers.join(", ")} konuşuyor` : "");
  $("talkButton").disabled = !joined || !localTrack || online.length > MAX_PEOPLE;
}

function updateTopStatus(text, online = false) {
  const badge = $("connectionStatus");
  badge.textContent = text;
  badge.classList.toggle("online", online);
}

async function sendSignal(toSession, kind, payload) {
  await addDoc(inboxRef(toSession), {
    fromSession: sessionId,
    fromUid: user.uid,
    toSession,
    kind,
    payload,
    createdAt: serverTimestamp()
  });
}

function queueSignal(peer, signal) {
  peer.signalQueue = peer.signalQueue.then(async () => {
    try {
      await handleSignal(peer, signal.data);
      await deleteDoc(signal.ref);
    } catch (error) {
      console.warn("Sinyal işlenemedi", error);
      say("radioMessage", "Bir bağlantı kurulamadı. Ağı değiştirip tekrar deneyin.");
    }
  });
}

async function handleSignal(peer, data) {
  if (data.kind === "candidate") {
    const candidate = JSON.parse(data.payload);
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
    else peer.pendingCandidates.push(candidate);
    return;
  }

  const description = JSON.parse(data.payload);
  if (data.kind === "offer" && !peer.pc.remoteDescription) {
    await peer.pc.setRemoteDescription(description);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    await sendSignal(peer.id, "answer", JSON.stringify(peer.pc.localDescription));
    await addPendingCandidates(peer);
  } else if (data.kind === "answer" && peer.pc.signalingState === "have-local-offer") {
    await peer.pc.setRemoteDescription(description);
    await addPendingCandidates(peer);
  }
}

async function addPendingCandidates(peer) {
  for (const candidate of peer.pendingCandidates.splice(0)) {
    try { await peer.pc.addIceCandidate(candidate); } catch (error) { console.warn("ICE adayı eklenemedi", error); }
  }
}

function receiveSignal(ref, data) {
  const peer = peers.get(data.fromSession);
  if (!peer) {
    const queue = bufferedSignals.get(data.fromSession) || [];
    queue.push({ ref, data });
    bufferedSignals.set(data.fromSession, queue);
    return;
  }
  queueSignal(peer, { ref, data });
}

async function startOffer(peer) {
  if (peer.offerStarted || sessionId.localeCompare(peer.id) > 0) return;
  peer.offerStarted = true;
  try {
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    await sendSignal(peer.id, "offer", JSON.stringify(peer.pc.localDescription));
  } catch (error) {
    console.warn("Teklif gönderilemedi", error);
  }
}

function addPeer(id, member) {
  if (peers.has(id) || !localStream || id === sessionId) return;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const peer = {
    id,
    name: member.name,
    pc,
    connected: false,
    offerStarted: false,
    pendingCandidates: [],
    signalQueue: Promise.resolve(),
    audio: null
  };
  peers.set(id, peer);
  for (const track of localStream.getAudioTracks()) pc.addTrack(track, localStream);

  pc.onicecandidate = event => {
    if (event.candidate) {
      sendSignal(id, "candidate", JSON.stringify(event.candidate.toJSON())).catch(() => {});
    }
  };
  pc.ontrack = event => {
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    $("audioElements").append(audio);
    peer.audio = audio;
    audio.play().catch(() => $("enableAudioButton").classList.remove("hidden"));
  };
  pc.onconnectionstatechange = () => {
    peer.connected = pc.connectionState === "connected";
    renderMembers();
    if (pc.connectionState === "failed") {
      say("radioMessage", "Bir cihazla bağlantı kurulamadı. Bazı ağlarda TURN gerekebilir.");
    }
  };

  const waiting = bufferedSignals.get(id) || [];
  bufferedSignals.delete(id);
  waiting.forEach(signal => queueSignal(peer, signal));
  startOffer(peer);
}

function closePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.close();
  peer.audio?.remove();
  peers.delete(id);
}

function watchChannel() {
  channelSnapshotInitialized = false;
  membersUnsubscribe = onSnapshot(query(members, limit(MAX_PEOPLE + 5)), snapshot => {
    const previousMembers = memberCache;
    const nextMembers = new Map(snapshot.docs.map(item => [item.id, item.data()]));
    if (channelSnapshotInitialized) notifyNewTalkers(previousMembers, nextMembers);
    channelSnapshotInitialized = true;
    memberCache = nextMembers;
    const onlineIds = new Set([...memberCache.entries()].filter(([, member]) => isFresh(member)).map(([id]) => id));
    for (const [id, member] of memberCache) {
      if (id !== sessionId && isFresh(member)) addPeer(id, member);
    }
    for (const id of peers.keys()) if (!onlineIds.has(id)) closePeer(id);
    renderMembers();
    updateTopStatus("KANALDA", true);
  }, error => say("radioMessage", `Bağlantı koptu: ${error.message}`));

  inboxUnsubscribe = onSnapshot(inboxRef(sessionId), snapshot => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "added") {
        receiveSignal(doc(db, "members", sessionId, "inbox", change.doc.id), change.doc.data());
      }
    }
  }, error => say("radioMessage", `Sinyal bağlantısı koptu: ${error.message}`));

  heartbeatTimer = setInterval(() => {
    if (joined && ownMemberRef) updateDoc(ownMemberRef, { lastSeen: serverTimestamp() }).catch(() => {});
  }, 15_000);
}

async function cleanStaleSessions() {
  const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS);
  const stale = await getDocs(query(members, where("lastSeen", "<", cutoff)));
  await Promise.all(stale.docs.map(item => deleteDoc(item.ref).catch(() => {})));
}

async function joinChannel() {
  const name = validName($("nameInput").value);
  if (!name) {
    say("joinMessage", "Önce adını yaz.");
    $("nameInput").focus();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    say("joinMessage", "Bu tarayıcıda mikrofon veya WebRTC kullanılamıyor.");
    return;
  }

  $("joinButton").disabled = true;
  say("joinMessage", "Kanala bağlanıyor…");
  try {
    user = (await signInAnonymously(auth)).user;
    await cleanStaleSessions();
    const current = await getDocs(query(members, limit(MAX_PEOPLE + 1)));
    const onlineCount = current.docs.filter(item => isFresh(item.data())).length;
    if (onlineCount >= MAX_PEOPLE) throw new Error("Kanal dolu; en fazla 10 kişi katılabilir.");

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    localTrack = localStream.getAudioTracks()[0];
    if (!localTrack) throw new Error("Mikrofon bulunamadı.");
    localTrack.enabled = false;
    sessionId = crypto.randomUUID();
    ownMemberRef = sessionRef(sessionId);
    await setDoc(ownMemberRef, {
      uid: user.uid,
      name,
      joinedAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      talking: false
    });

    joined = true;
    try { localStorage.setItem("telsiz-name", name); } catch {}
    $("joinPanel").classList.add("hidden");
    $("radioPanel").classList.remove("hidden");
    say("radioMessage", "Hazır. Basılı tutup konuş.");
    watchChannel();
  } catch (error) {
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    localTrack = null;
    say("joinMessage", error.code === "permission-denied" ? "Mikrofon izni ver; sonra tekrar katıl." : error.message || "Kanala girilemedi.");
  } finally {
    $("joinButton").disabled = false;
  }
}

function setTalking(value) {
  if (!joined || !localTrack || talking === value) return;
  talking = value;
  localTrack.enabled = value;
  $("talkButton").classList.toggle("pressed", value);
  $("talkButton").setAttribute("aria-pressed", String(value));
  say("talkLabel", value ? "KONUŞUYORSUN" : "BASILI TUT, KONUŞ");
  updateDoc(ownMemberRef, { talking: value, lastSeen: serverTimestamp() }).catch(() => {});
  renderMembers();
}

async function leaveChannel() {
  setTalking(false);
  joined = false;
  clearInterval(heartbeatTimer);
  membersUnsubscribe?.();
  inboxUnsubscribe?.();
  for (const id of [...peers.keys()]) closePeer(id);
  localStream?.getTracks().forEach(track => track.stop());
  localStream = null;
  localTrack = null;
  if (sessionId) {
    const pending = await getDocs(inboxRef(sessionId)).catch(() => null);
    if (pending) await Promise.all(pending.docs.map(item => deleteDoc(item.ref).catch(() => {})));
  }
  if (ownMemberRef) await deleteDoc(ownMemberRef).catch(() => {});
  ownMemberRef = null;
  memberCache.clear();
  channelSnapshotInitialized = false;
  bufferedSignals.clear();
  clearTimeout(talkToastTimer);
  $("talkToast").classList.add("hidden");
  $("audioElements").replaceChildren();
  $("joinPanel").classList.remove("hidden");
  $("radioPanel").classList.add("hidden");
  $("enableAudioButton").classList.add("hidden");
  say("radioMessage", "");
  say("joinMessage", "Kanaldan ayrıldın.");
  updateTopStatus("HAZIR");
}

$("joinButton").addEventListener("click", joinChannel);
$("nameInput").addEventListener("keydown", event => { if (event.key === "Enter") joinChannel(); });
$("leaveButton").addEventListener("click", leaveChannel);
$("talkButton").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  setTalking(true);
});
["pointerup", "pointercancel", "lostpointercapture", "pointerleave"].forEach(type => {
  $("talkButton").addEventListener(type, () => setTalking(false));
});
$("talkButton").addEventListener("contextmenu", event => event.preventDefault());
$("enableAudioButton").addEventListener("click", async () => {
  for (const peer of peers.values()) await peer.audio?.play().catch(() => {});
  $("enableAudioButton").classList.add("hidden");
});
document.addEventListener("visibilitychange", () => { if (document.hidden) setTalking(false); });
window.addEventListener("blur", () => setTalking(false));
window.addEventListener("pagehide", () => {
  if (sessionId) getDocs(inboxRef(sessionId)).then(snapshot => Promise.all(snapshot.docs.map(item => deleteDoc(item.ref)))).catch(() => {});
  if (ownMemberRef) deleteDoc(ownMemberRef).catch(() => {});
  for (const peer of peers.values()) peer.pc.close();
  localStream?.getTracks().forEach(track => track.stop());
});

try { $("nameInput").value = localStorage.getItem("telsiz-name") || ""; } catch {}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
