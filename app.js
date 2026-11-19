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
let microphoneTrack = null;
let outgoingStream = null;
let audioContext = null;
let pttToneGain = null;
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
  if ("Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready
      .then(registration => registration.showNotification("TELSİZ", {
        body: message,
        icon: "/icons/icon.svg",
        tag: "telsiz-talk-start",
        renotify: true
      }))
      .catch(() => {});
  }
}

async function enableNotifications() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (isIOS && !isStandalone) {
    say("notificationMessage", "iPhone’da önce Safari: Paylaş → Ana Ekrana Ekle. Sonra TELSİZ’i simgeden açıp bu düğmeye bas.");
    return;
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    say("notificationMessage", "Bu tarayıcı sistem bildirimlerini desteklemiyor.");
    return;
  }

  try {
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission === "granted") {
      $("notificationButton").textContent = "BİLDİRİMLER AÇIK";
      $("notificationButton").disabled = true;
      say("notificationMessage", "TELSİZ açıkken biri konuşmaya başlayınca sistem bildirimi gösterilecek.");
    } else {
      say("notificationMessage", "Bildirim izni verilmedi. iPhone Ayarlar’dan TELSİZ bildirimlerine izin ver.");
    }
  } catch {
    say("notificationMessage", "Bildirim izni alınamadı. TELSİZ’i Ana Ekran simgesinden açıp tekrar dene.");
  }
}

function notifyNewTalkers(previous, current) {
  const names = [...current.entries()]
    .filter(([id, member]) => id !== sessionId && isFresh(member) && member.talking && !previous.get(id)?.talking)
    .map(([, member]) => member.name);
  if (names.length) announceTalkers(names);
}

function playPttTone() {
  if (!audioContext || !pttToneGain) return;
  audioContext.resume().catch(() => {});
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(980, now);
  envelope.gain.setValueAtTime(0.001, now);
  envelope.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
  envelope.gain.exponentialRampToValueAtTime(0.001, now + 0.095);
  oscillator.connect(envelope).connect(pttToneGain);
  oscillator.start(now);
  oscillator.stop(now + 0.1);
}

function createRadioAudioTrack() {
  microphoneTrack = localStream?.getAudioTracks()[0] || null;
  if (!microphoneTrack) throw new Error("Mikrofon bulunamadı.");
  microphoneTrack.enabled = false;

  if (!audioContext) {
    localTrack = microphoneTrack;
    outgoingStream = localStream;
    return;
  }

  const source = audioContext.createMediaStreamSource(localStream);
  const highPass = audioContext.createBiquadFilter();
  highPass.type = "highpass";
  highPass.frequency.value = 300;
  const lowPass = audioContext.createBiquadFilter();
  lowPass.type = "lowpass";
  lowPass.frequency.value = 3000;
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -23;
  compressor.knee.value = 18;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  const destination = audioContext.createMediaStreamDestination();
  pttToneGain = audioContext.createGain();

  source.connect(highPass).connect(lowPass).connect(compressor);
  pttToneGain.connect(compressor);
  compressor.connect(destination);
  outgoingStream = destination.stream;
  localTrack = outgoingStream.getAudioTracks()[0];
  localTrack.enabled = false;
}

function closeRadioAudio() {
  if (microphoneTrack) microphoneTrack.enabled = false;
  if (localTrack) localTrack.enabled = false;
  talking = false;
  outgoingStream?.getTracks().forEach(track => track.stop());
  outgoingStream = null;
  microphoneTrack = null;
  localTrack = null;
  pttToneGain = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
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
  if (peers.has(id) || !outgoingStream || id === sessionId) return;
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
  for (const track of outgoingStream.getAudioTracks()) pc.addTrack(track, outgoingStream);

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
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (AudioContextType && !audioContext) {
      audioContext = new AudioContextType({ latencyHint: "interactive" });
      audioContext.resume().catch(() => {});
    }
    user = (await signInAnonymously(auth)).user;
    await cleanStaleSessions();
    const current = await getDocs(query(members, limit(MAX_PEOPLE + 1)));
    const onlineCount = current.docs.filter(item => isFresh(item.data())).length;
    if (onlineCount >= MAX_PEOPLE) throw new Error("Kanal dolu; en fazla 10 kişi katılabilir.");

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    createRadioAudioTrack();
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
    closeRadioAudio();
    say("joinMessage", error.code === "permission-denied" ? "Mikrofon izni ver; sonra tekrar katıl." : error.message || "Kanala girilemedi.");
  } finally {
    $("joinButton").disabled = false;
  }
}

function setTalking(value) {
  if (!joined || !localTrack || talking === value) return;
  talking = value;
  if (microphoneTrack) microphoneTrack.enabled = value;
  localTrack.enabled = value;
  if (value) playPttTone();
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
  closeRadioAudio();
  const leavingSessionId = sessionId;
  if (leavingSessionId) {
    const pending = await getDocs(inboxRef(leavingSessionId)).catch(() => null);
    if (pending) await Promise.all(pending.docs.map(item => deleteDoc(item.ref).catch(() => {})));
  }
  if (ownMemberRef) await deleteDoc(ownMemberRef).catch(() => {});
  ownMemberRef = null;
  sessionId = "";
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
window.addEventListener("blur", () => setTalking(false));
function exitForBackground() {
  if (localTrack) localTrack.enabled = false;
  if (microphoneTrack) microphoneTrack.enabled = false;
  if (joined && talking) setTalking(false);
  if (joined) {
    void leaveChannel();
  } else {
    localStream?.getTracks().forEach(track => track.stop());
    localStream = null;
    closeRadioAudio();
  }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) exitForBackground(); });
window.addEventListener("pagehide", exitForBackground);
$("notificationButton").addEventListener("click", enableNotifications);
if ("Notification" in window && Notification.permission === "granted") {
  $("notificationButton").textContent = "BİLDİRİMLER AÇIK";
  $("notificationButton").disabled = true;
  say("notificationMessage", "TELSİZ açıkken biri konuşmaya başlayınca sistem bildirimi gösterilecek.");
}

try { $("nameInput").value = localStorage.getItem("telsiz-name") || ""; } catch {}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
