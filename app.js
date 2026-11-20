import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getFunctions, httpsCallable } from "firebase/functions";
import {
  addDoc, collection, deleteDoc, doc, getDocs, getFirestore, limit, onSnapshot, orderBy,
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
const functions = getFunctions(app, "europe-west3");
const members = collection(db, "members");
const MAX_PEOPLE = 10;
const STALE_MS = 45_000;
let ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
let usingManagedTurn = false;
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
let talkReleaseTimer = null;

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
    say("notificationMessage", isIOS
      ? "iPhone web bildirimleri için iOS 16.4 veya üstü ve Ana Ekran uygulaması gerekir."
      : "Bu tarayıcı sistem bildirimlerini desteklemiyor.");
    return;
  }

  try {
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission === "granted") {
      $("notificationButton").textContent = "BİLDİRİMİ TEST ET";
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification("TELSİZ bildirimi çalışıyor", {
        body: "Bu telefonda bildirim izni açık.",
        icon: "/icons/apple-touch-icon.png",
        tag: "telsiz-notification-test"
      });
      say("notificationMessage", "Deneme bildirimi gönderildi. Konuşma bildirimleri TELSİZ açıkken gelir.");
    } else {
      say("notificationMessage", "İzin kapalı. iPhone Ayarlar → Bildirimler → TELSİZ bölümünden izin ver.");
    }
  } catch {
    say("notificationMessage", "Bildirim açılamadı. TELSİZ’i Ana Ekran simgesinden açıp tekrar dene.");
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
  const now = audioContext.currentTime;
  for (const start of [now, now + 0.085]) {
    const oscillator = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(1040, start);
    envelope.gain.setValueAtTime(0.001, start);
    envelope.gain.exponentialRampToValueAtTime(0.24, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.06);
    oscillator.connect(envelope).connect(pttToneGain);
    oscillator.start(start);
    oscillator.stop(start + 0.065);
  }

  const noiseLength = Math.floor(audioContext.sampleRate * 0.035);
  const noiseBuffer = audioContext.createBuffer(1, noiseLength, audioContext.sampleRate);
  const noise = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noise.length; i++) {
    const fade = 1 - i / noise.length;
    noise[i] = (Math.random() * 2 - 1) * fade;
  }
  const crackle = audioContext.createBufferSource();
  const crackleGain = audioContext.createGain();
  crackle.buffer = noiseBuffer;
  crackleGain.gain.value = 0.14;
  crackle.connect(crackleGain).connect(pttToneGain);
  crackle.start(now);
}

function playReleaseTone() {
  if (!audioContext || !pttToneGain || audioContext.state === "closed") return;
  const start = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(760, start);
  envelope.gain.setValueAtTime(0.001, start);
  envelope.gain.exponentialRampToValueAtTime(0.13, start + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.075);
  oscillator.connect(envelope).connect(pttToneGain);
  oscillator.start(start);
  oscillator.stop(start + 0.08);
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
  highPass.frequency.value = 330;
  const lowPass = audioContext.createBiquadFilter();
  lowPass.type = "lowpass";
  lowPass.frequency.value = 2600;
  const drive = audioContext.createGain();
  drive.gain.value = 1.8;
  const saturation = audioContext.createWaveShaper();
  const curve = new Float32Array(256);
  const amount = 2.4;
  const normalization = Math.tanh(amount);
  for (let i = 0; i < curve.length; i++) {
    const sample = (i * 2) / (curve.length - 1) - 1;
    curve[i] = Math.tanh(amount * sample) / normalization;
  }
  saturation.curve = curve;
  saturation.oversample = "2x";
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -28;
  compressor.knee.value = 12;
  compressor.ratio.value = 7;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.12;
  const destination = audioContext.createMediaStreamDestination();
  pttToneGain = audioContext.createGain();

  source.connect(highPass).connect(lowPass).connect(drive).connect(saturation).connect(compressor);
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

async function refreshIceServers() {
  usingManagedTurn = false;
  ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
  try {
    const callable = httpsCallable(functions, "getTurnCredentials", { timeout: 8000 });
    const result = await callable();
    const servers = result.data?.iceServers;
    if (!Array.isArray(servers)) return;
    const valid = servers.filter(server => server && (typeof server.urls === "string" || Array.isArray(server.urls)));
    if (!valid.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => url.startsWith("turn:")))) return;
    ICE_SERVERS = valid;
    usingManagedTurn = true;
  } catch (error) {
    console.info("Managed TURN is not configured; continuing with STUN", error.code || error.message);
  }
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
  if (data.kind === "offer" && peer.pc.signalingState === "stable") {
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

async function startOffer(peer, restart = false) {
  if ((!restart && peer.offerStarted) || sessionId.localeCompare(peer.id) > 0) return;
  peer.offerStarted = true;
  try {
    if (restart && peer.pc.signalingState === "have-local-offer") {
      await peer.pc.setLocalDescription({ type: "rollback" });
    }
    if (peer.pc.signalingState !== "stable") return;
    if (restart) peer.pc.restartIce?.();
    const offer = await peer.pc.createOffer(restart ? { iceRestart: true } : undefined);
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
    restartTimer: null,
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
    clearTimeout(peer.restartTimer);
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      peer.restartTimer = setTimeout(() => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          void startOffer(peer, true);
        }
      }, pc.connectionState === "failed" ? 0 : 5000);
    }
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
  clearTimeout(peer.restartTimer);
  peer.pc.close();
  peer.audio?.remove();
  peers.delete(id);
}

function watchChannel() {
  channelSnapshotInitialized = false;
  membersUnsubscribe = onSnapshot(query(members, orderBy("lastSeen", "desc"), limit(MAX_PEOPLE + 5)), snapshot => {
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
  rememberName(name);
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
    await refreshIceServers();
    await cleanStaleSessions();
    const current = await getDocs(query(members, limit(MAX_PEOPLE + 1)));
    const onlineCount = current.docs.filter(item => isFresh(item.data())).length;
    if (onlineCount >= MAX_PEOPLE) throw new Error("Kanal dolu; en fazla 10 kişi katılabilir.");

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    try { localStorage.setItem("telsiz-mic-authorized", "yes"); } catch {}
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
    say("radioMessage", usingManagedTurn
      ? "Hazır. Basılı tutup konuş."
      : "Hazır. Bazı ağlarda TURN kurulana kadar bağlantı olmayabilir.");
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

function setTalking(value, playTail = false) {
  if (!joined || !localTrack || talking === value) return;
  clearTimeout(talkReleaseTimer);
  talking = value;
  if (microphoneTrack) microphoneTrack.enabled = value;
  if (value) {
    localTrack.enabled = true;
    playPttTone();
  } else if (playTail && !document.hidden && audioContext?.state !== "closed") {
    // Mute the mic immediately; leave the outgoing track open only for the short radio tail.
    localTrack.enabled = true;
    playReleaseTone();
    talkReleaseTimer = setTimeout(() => {
      if (!talking && localTrack) localTrack.enabled = false;
    }, 100);
  } else {
    localTrack.enabled = false;
  }
  $("talkButton").classList.toggle("pressed", value);
  $("talkButton").setAttribute("aria-pressed", String(value));
  say("talkLabel", value ? "KONUŞUYORSUN" : "BASILI TUT, KONUŞ");
  updateDoc(ownMemberRef, { talking: value, lastSeen: serverTimestamp() }).catch(() => {});
  renderMembers();
}

async function leaveChannel() {
  setTalking(false);
  joined = false;
  clearTimeout(talkReleaseTimer);
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
$("nameInput").addEventListener("input", () => rememberName($("nameInput").value));
$("nameInput").addEventListener("change", () => rememberName($("nameInput").value));
$("leaveButton").addEventListener("click", leaveChannel);
$("talkButton").addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  event.preventDefault();
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  setTalking(true);
});
["pointerup", "pointercancel", "lostpointercapture", "pointerleave"].forEach(type => {
  $("talkButton").addEventListener(type, () => setTalking(false, type === "pointerup"));
});
$("talkButton").addEventListener("contextmenu", event => event.preventDefault());
$("enableAudioButton").addEventListener("click", async () => {
  for (const peer of peers.values()) await peer.audio?.play().catch(() => {});
  $("enableAudioButton").classList.add("hidden");
});
window.addEventListener("blur", () => setTalking(false));
function muteForBackground() {
  if (joined && talking) setTalking(false);
  else {
    if (localTrack) localTrack.enabled = false;
    if (microphoneTrack) microphoneTrack.enabled = false;
  }
}

async function restorePresence() {
  if (!joined || !ownMemberRef || !user) return;
  let savedName = "Misafir";
  try { savedName = localStorage.getItem("telsiz-name") || savedName; } catch {}
  const name = validName($("nameInput").value) || savedName;
  try {
    await updateDoc(ownMemberRef, { lastSeen: serverTimestamp(), talking: false });
  } catch {
    try {
      await setDoc(ownMemberRef, {
        uid: user.uid,
        name,
        joinedAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
        talking: false
      });
    } catch (error) {
      say("radioMessage", `Kanala yeniden bağlanılamadı: ${error.message}`);
      return;
    }
  }
  if (microphoneTrack?.readyState === "ended") {
    say("radioMessage", "Mikrofon yeniden bağlanıyor…");
    const previousStream = localStream;
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    try {
      closeRadioAudio();
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      if (AudioContextType) audioContext = new AudioContextType({ latencyHint: "interactive" });
      createRadioAudioTrack();
      await Promise.all([...peers.values()].map(peer => {
        const sender = peer.pc.getSenders().find(item => item.track?.kind === "audio");
        return sender ? sender.replaceTrack(localTrack) : Promise.resolve();
      }));
      previousStream?.getTracks().forEach(track => track.stop());
      renderMembers();
      say("radioMessage", "Mikrofon ve kanal yeniden bağlandı. Konuşmak için uygulama açık olmalı.");
    } catch (error) {
      previousStream?.getTracks().forEach(track => track.stop());
      localStream = null;
      closeRadioAudio();
      renderMembers();
      say("radioMessage", "iPhone mikrofonu arka planda durdurdu. Kanaldan çıkıp yeniden katıl.");
      console.warn("Mikrofon geri yüklenemedi", error);
    }
  } else {
    for (const [id, peer] of peers) {
      if (["failed", "closed"].includes(peer.pc.connectionState)) {
        closePeer(id);
        const member = memberCache.get(id);
        if (member && isFresh(member)) addPeer(id, member);
      }
    }
    say("radioMessage", "Kanala döndün. iPhone arka planda canlı sesi durdurabilir; konuşmak için uygulama açık olmalı.");
  }
  renderMembers();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    muteForBackground();
  } else void restorePresence();
});
window.addEventListener("pagehide", muteForBackground);
$("notificationButton").addEventListener("click", enableNotifications);
if ("Notification" in window && Notification.permission === "granted") {
  $("notificationButton").textContent = "BİLDİRİMİ TEST ET";
  say("notificationMessage", "Bildirim izni açık. Düğmeye basıp deneme bildirimi gönder.");
}

function rememberName(value) {
  try { localStorage.setItem("telsiz-name", validName(value)); } catch {}
}
try { $("nameInput").value = localStorage.getItem("telsiz-name") || ""; } catch {}
try {
  if (localStorage.getItem("telsiz-mic-authorized") === "yes") {
    say("micMessage", "Bu cihazda mikrofon izni daha önce verildi. Tarayıcı izni korunuyorsa tekrar sormaz.");
  }
} catch {}
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
