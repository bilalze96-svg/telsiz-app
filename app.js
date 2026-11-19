import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import {
  getFirestore, collection, doc, getDoc, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, serverTimestamp
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";

// Firebase web configuration contains public client identifiers; Firestore Rules protect data.
const firebaseConfig = {
  apiKey: "AIzaSyDdXDYDxwbLn3BhnQGxJzhsQnKc0TP1EM",
  authDomain: "telsiz-app-88ecf.firebaseapp.com",
  projectId: "telsiz-app-88ecf",
  storageBucket: "telsiz-app-88ecf.firebasestorage.app",
  messagingSenderId: "217716786139",
  appId: "1:217716786139:web:0d7bf957bf2f5afa031dfe"
};

const $ = (id) => document.getElementById(id);
const inviteFromUrl = new URLSearchParams(location.search).get("room");
const appInstance = initializeApp(firebaseConfig);
const auth = getAuth(appInstance);
const FIRESTORE_DATABASE_ID = "default";
const db = getFirestore(appInstance, FIRESTORE_DATABASE_ID);
const functions = getFunctions(appInstance, "europe-west1");
const issueRoomToken = httpsCallable(functions, "getRoomToken");
const moderateMember = httpsCallable(functions, "moderateRoomMember");

let user = null;
let roomId = "";
let displayName = "";
let isHost = false;
let active = false;
let memberApproved = false;
let talkPressed = false;
let manuallyMuted = false;
let micTrack = null;
let micOperation = Promise.resolve();
let liveKitRoom = null;
let voiceConnectPromise = null;
let liveKitSDKPromise = null;
let liveKitSDK = null;
let memberCache = new Map();
let roomUnsubscribe = null;
let ownMemberUnsubscribe = null;
let memberListUnsubscribe = null;
let cleanupPromise = null;

function message(id, text) { $(id).textContent = text; }
function setRoomState(text) { $("roomState").textContent = text; }
function roomRef() { return doc(db, "rooms", roomId); }
function membersRef() { return collection(db, "rooms", roomId, "members"); }
function memberRef(uid = user.uid) { return doc(db, "rooms", roomId, "members", uid); }
function cleanName(value) {
  return value.trim().replace(/[<>]/g, "").replace(/\s+/g, " ").slice(0, 24);
}
function inviteCode(value) {
  const input = (value || "").trim();
  let code = input;
  try {
    const parsed = new URL(input);
    code = parsed.searchParams.get("room") || input;
  } catch {}
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}
function errorText(error) {
  return error?.message || "Beklenmeyen bir hata oluştu.";
}

function loadLiveKitSDK() {
  if (!liveKitSDKPromise) liveKitSDKPromise = import("livekit-client").then(sdk => {
    liveKitSDK = sdk;
    return sdk;
  });
  return liveKitSDKPromise;
}

function stopListeners() {
  [roomUnsubscribe, ownMemberUnsubscribe, memberListUnsubscribe].forEach(unsubscribe => unsubscribe?.());
  roomUnsubscribe = null;
  ownMemberUnsubscribe = null;
  memberListUnsubscribe = null;
}

function showRoom() {
  $("welcome").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomName").textContent = "EKİP ODASI";
  $("inviteText").textContent = `${location.origin}${location.pathname}?room=${roomId}`;
  $("closeRoom").classList.toggle("hidden", !isHost);
  $("requestsBox").classList.toggle("hidden", !isHost);
  $("talkButton").disabled = true;
  $("talkButton").querySelector("small").textContent = "Ses bağlantısı kuruluyor";
  $("muteButton").disabled = true;
}

function showWelcome(text = "") {
  $("room").classList.add("hidden");
  $("welcome").classList.remove("hidden");
  message("welcomeMsg", text);
  history.replaceState({}, "", location.pathname);
}

function renderPeople() {
  const people = [...memberCache.values()].filter(member => member.status === "approved");
  const remoteParticipants = liveKitRoom?.remoteParticipants;
  $("people").replaceChildren();
  people.forEach(member => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = member.name || "Katılımcı";
    const state = document.createElement("span");
    state.className = "person-state";
    state.textContent = member.uid === user.uid
      ? "Bu cihaz"
      : remoteParticipants?.has(member.uid) ? "Ses bağlı" : "Onaylandı";
    li.append(name, state);
    $("people").append(li);
  });
  $("peopleCount").textContent = `${people.length} kişi`;
}

function renderRequests() {
  const box = $("requests");
  box.replaceChildren();
  [...memberCache.values()].filter(member => member.status === "pending").forEach(member => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = member.name || "Misafir";
    const actions = document.createElement("span");
    const approve = document.createElement("button");
    approve.className = "copy";
    approve.textContent = "Onayla";
    approve.addEventListener("click", () => decideMember(member.uid, "approved"));
    const reject = document.createElement("button");
    reject.className = "danger request-reject";
    reject.textContent = "Reddet";
    reject.addEventListener("click", () => decideMember(member.uid, "rejected"));
    actions.append(approve, reject);
    li.append(name, actions);
    box.append(li);
  });
}

function renderRoom() {
  renderPeople();
  if (isHost) renderRequests();
}

async function decideMember(uid, decision) {
  try {
    await moderateMember({ roomId, memberUid: uid, decision });
    message("roomMsg", decision === "approved" ? "Katılımcı onaylandı." : "Katılma isteği reddedildi.");
  } catch (error) {
    message("roomMsg", `İşlem başarısız: ${errorText(error)}`);
  }
}

function attachRemoteAudio(track, _publication, participant) {
  if (track.kind !== liveKitSDK.Track.Kind.Audio) return;
  const element = track.attach();
  element.id = `audio-${participant.identity}`;
  element.autoplay = true;
  element.playsInline = true;
  $("audioElements").append(element);
  element.play().catch(() => {
    $("enableAudioButton").classList.remove("hidden");
    message("roomMsg", "Karşı tarafın sesini duymak için “Sesi etkinleştir” düğmesine dokunun.");
  });
}

function removeRemoteAudio(track) {
  track.detach().forEach(element => element.remove());
}

function updateAudioPlaybackButton(room) {
  $("enableAudioButton").classList.toggle("hidden", room.canPlaybackAudio);
}

async function connectVoice() {
  if (!active || !memberApproved) return;
  if (liveKitRoom && liveKitSDK && liveKitRoom.state === liveKitSDK.ConnectionState.Connected) return;
  if (voiceConnectPromise) return voiceConnectPromise;
  if (liveKitRoom) {
    const staleRoom = liveKitRoom;
    liveKitRoom = null;
    await staleRoom.disconnect().catch(() => {});
  }

  voiceConnectPromise = (async () => {
    setRoomState("SES BAĞLANIYOR");
    $("talkButton").disabled = true;
    $("retryVoiceButton").classList.add("hidden");
    try {
      const [sdk, response] = await Promise.all([
        loadLiveKitSDK(),
        issueRoomToken({ roomId })
      ]);
      if (!active || !memberApproved) return;

      const room = new sdk.Room();
      liveKitRoom = room;
      room.on(sdk.RoomEvent.TrackSubscribed, attachRemoteAudio);
      room.on(sdk.RoomEvent.TrackUnsubscribed, removeRemoteAudio);
      room.on(sdk.RoomEvent.ParticipantConnected, renderPeople);
      room.on(sdk.RoomEvent.ParticipantDisconnected, renderPeople);
      room.on(sdk.RoomEvent.AudioPlaybackStatusChanged, () => updateAudioPlaybackButton(room));
      room.on(sdk.RoomEvent.ConnectionStateChanged, state => {
        if (state === sdk.ConnectionState.Connected) {
          setRoomState("BAĞLI");
          $("talkButton").disabled = false;
          $("talkButton").querySelector("small").textContent = "Basılı tutarak konuş";
          $("muteButton").disabled = false;
          updateAudioPlaybackButton(room);
        } else if (state === sdk.ConnectionState.Reconnecting) {
          setRoomState("YENİDEN BAĞLANIYOR");
          $("talkButton").disabled = true;
          releaseTalk();
        } else if (state === sdk.ConnectionState.Disconnected && active) {
          setRoomState("SES BAĞLANTISI KESİLDİ");
          $("talkButton").disabled = true;
          $("retryVoiceButton").classList.remove("hidden");
          releaseTalk();
        }
      });

      await room.connect(response.data.serverUrl, response.data.token);
      if (!active) {
        await room.disconnect();
        return;
      }
      setRoomState("BAĞLI");
      $("talkButton").disabled = false;
      $("talkButton").querySelector("small").textContent = "Basılı tutarak konuş";
      $("muteButton").disabled = false;
      updateAudioPlaybackButton(room);
      renderPeople();
    } catch (error) {
      if (liveKitRoom) await liveKitRoom.disconnect().catch(() => {});
      liveKitRoom = null;
      setRoomState("SES BAĞLANTISI YOK");
      $("talkButton").disabled = true;
      $("retryVoiceButton").classList.remove("hidden");
      message("roomMsg", `Ses bağlantısı kurulamadı: ${errorText(error)}`);
      throw error;
    }
  })();

  try {
    await voiceConnectPromise;
  } finally {
    voiceConnectPromise = null;
  }
}

function listenForMembers() {
  if (memberListUnsubscribe) return;
  const source = isHost
    ? membersRef()
    : query(membersRef(), where("status", "==", "approved"));
  memberListUnsubscribe = onSnapshot(source, snapshot => {
    memberCache.clear();
    snapshot.forEach(member => memberCache.set(member.id, { uid: member.id, ...member.data() }));
    renderRoom();
  }, error => message("roomMsg", `Katılımcı listesi okunamadı: ${errorText(error)}`));
}

async function handleOwnMembership(snapshot) {
  if (!snapshot.exists()) {
    if (memberApproved) {
      await cleanup(false);
      showWelcome("Oda üyeliğin sona erdi.");
    }
    return;
  }
  const status = snapshot.data().status;
  if (status === "rejected") {
    await cleanup(false);
    showWelcome("Katılma isteğin reddedildi.");
    return;
  }
  if (status !== "approved") {
    memberApproved = false;
    setRoomState("ONAY BEKLENİYOR");
    $("talkButton").disabled = true;
    message("roomMsg", "Oda sahibinin katılma isteğini onaylaması bekleniyor.");
    return;
  }

  memberApproved = true;
  listenForMembers();
  if (!liveKitRoom && !voiceConnectPromise) connectVoice().catch(() => {});
}

function startRoomListeners() {
  stopListeners();
  roomUnsubscribe = onSnapshot(roomRef(), snapshot => {
    if (!snapshot.exists() || snapshot.data().status === "closed") {
      cleanup(false).then(() => showWelcome("Oda kapatıldı."));
    }
  }, error => message("roomMsg", `Oda durumu okunamadı: ${errorText(error)}`));
  ownMemberUnsubscribe = onSnapshot(memberRef(), snapshot => {
    handleOwnMembership(snapshot).catch(error => message("roomMsg", errorText(error)));
  }, error => message("roomMsg", `Üyelik durumu okunamadı: ${errorText(error)}`));
}

function syncMicState() {
  if (!micTrack) return Promise.resolve();
  const track = micTrack;
  micOperation = micOperation.then(async () => {
    if (track !== micTrack) return;
    const shouldTransmit = active && memberApproved && talkPressed && !manuallyMuted &&
      Boolean(liveKitRoom && liveKitSDK && liveKitRoom.state === liveKitSDK.ConnectionState.Connected);
    if (shouldTransmit && track.isMuted) await track.unmute();
    if (!shouldTransmit && !track.isMuted) await track.mute();
  }).catch(error => message("roomMsg", `Mikrofon durumu değiştirilemedi: ${errorText(error)}`));
  return micOperation;
}

function releaseTalk() {
  talkPressed = false;
  $("talkButton").classList.remove("active");
  $("talkButton").setAttribute("aria-pressed", "false");
  $("talkButton").querySelector("small").textContent = manuallyMuted
    ? "Mikrofon kapalı"
    : "Basılı tutarak konuş";
  syncMicState();
}

async function startTalking(event) {
  if (event && event.button !== undefined && event.button !== 0) return;
  if (!active || !memberApproved || !liveKitRoom || !liveKitSDK ||
      liveKitRoom.state !== liveKitSDK.ConnectionState.Connected || $("talkButton").disabled || talkPressed) return;
  talkPressed = true;
  $("talkButton").classList.add("active");
  $("talkButton").setAttribute("aria-pressed", "true");
  $("talkButton").querySelector("small").textContent = manuallyMuted ? "Mikrofon kapalı" : "KONUŞUYORSUN";
  liveKitRoom.startAudio().catch(() => {});
  if (manuallyMuted) {
    message("roomMsg", "Konuşmak için önce mikrofon kilidini açın.");
    return;
  }

  try {
    if (!micTrack || micTrack.mediaStreamTrack.readyState === "ended") {
      micTrack = await liveKitSDK.createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      });
      await micTrack.mute();
      if (!talkPressed || manuallyMuted || !active) {
        micTrack.stop();
        micTrack = null;
        return;
      }
      await liveKitRoom.localParticipant.publishTrack(micTrack, { source: liveKitSDK.Track.Source.Microphone });
    }
    await syncMicState();
  } catch (error) {
    releaseTalk();
    message("roomMsg", `Mikrofon açılamadı. HTTPS ve mikrofon iznini kontrol edin: ${errorText(error)}`);
  }
}

async function cleanup(redirect = true) {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    active = false;
    memberApproved = false;
    talkPressed = false;
    stopListeners();
    if (liveKitRoom) {
      const room = liveKitRoom;
      liveKitRoom = null;
      await room.disconnect().catch(() => {});
    }
    micTrack = null;
    $("audioElements").replaceChildren();
    $("talkButton").classList.remove("active");
    $("talkButton").setAttribute("aria-pressed", "false");
    if (redirect) location.href = location.pathname;
  })();
  try {
    await cleanupPromise;
  } finally {
    cleanupPromise = null;
  }
}

async function createRoom() {
  if (!user) return;
  displayName = cleanName($("displayName").value);
  if (!displayName) return message("welcomeMsg", "Önce görünen adını yaz.");
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
  roomId = id;
  isHost = true;
  active = true;
  manuallyMuted = false;
  $("muteButton").textContent = "Mikrofonu kilitle";
  try {
    await setDoc(roomRef(), {
      hostUid: user.uid,
      status: "open",
      createdAt: serverTimestamp(),
      title: "EKİP ODASI"
    });
    await setDoc(memberRef(), {
      name: displayName,
      status: "approved",
      joinedAt: serverTimestamp()
    });
    history.replaceState({}, "", `?room=${id}`);
    showRoom();
    startRoomListeners();
    setRoomState("ODA AÇIK");
    message("roomMsg", "Oda oluşturuldu. Davet bağlantısını ekibinle paylaşabilirsin.");
  } catch (error) {
    active = false;
    isHost = false;
    message("welcomeMsg", `Oda oluşturulamadı: ${errorText(error)}`);
  }
}

async function requestJoin() {
  if (!user) return;
  displayName = cleanName($("displayName").value);
  const id = inviteCode($("inviteCode").value || inviteFromUrl);
  if (!displayName) return message("welcomeMsg", "Önce görünen adını yaz.");
  if (!/^[A-Z0-9]{12}$/.test(id)) return message("welcomeMsg", "12 karakterli geçerli davet kodunu gir.");
  roomId = id;
  manuallyMuted = false;
  $("muteButton").textContent = "Mikrofonu kilitle";
  try {
    const roomSnapshot = await getDoc(roomRef());
    if (!roomSnapshot.exists() || roomSnapshot.data().status !== "open") {
      return message("welcomeMsg", "Bu oda bulunamadı veya kapatılmış.");
    }
    isHost = roomSnapshot.data().hostUid === user.uid;
    const existingMember = await getDoc(memberRef());
    if (existingMember.exists() && existingMember.data().status === "rejected") {
      await deleteDoc(memberRef());
    }
    const refreshedMember = existingMember.exists() && existingMember.data().status !== "rejected"
      ? existingMember
      : null;
    if (refreshedMember) {
      if (refreshedMember.data().name !== displayName) await updateDoc(memberRef(), { name: displayName });
    } else {
      await setDoc(memberRef(), {
        name: displayName,
        status: isHost ? "approved" : "pending",
        joinedAt: serverTimestamp()
      });
    }
    active = true;
    history.replaceState({}, "", `?room=${id}`);
    showRoom();
    startRoomListeners();
    message("roomMsg", "Katılma isteğin gönderildi.");
  } catch (error) {
    message("welcomeMsg", `Katılma isteği gönderilemedi: ${errorText(error)}`);
  }
}

async function closeRoom() {
  if (!isHost) return;
  try {
    await updateDoc(roomRef(), { status: "closed", closedAt: serverTimestamp() });
    await cleanup(false);
    showWelcome("Oda kapatıldı.");
  } catch (error) {
    message("roomMsg", `Oda kapatılamadı: ${errorText(error)}`);
  }
}

async function leaveRoom() {
  if (!active) return;
  if (isHost) return closeRoom();
  await cleanup(false);
  try { await deleteDoc(memberRef()); } catch (error) { console.warn("Could not remove membership", error); }
  showWelcome("Odadan ayrıldın.");
}

$("createRoom").addEventListener("click", createRoom);
$("requestJoin").addEventListener("click", requestJoin);
$("copyInvite").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("inviteText").textContent);
    $("copyInvite").textContent = "KOPYALANDI";
  } catch {
    message("roomMsg", "Bağlantı kopyalanamadı; adres çubuğundan kopyalayın.");
  }
});
$("leaveButton").addEventListener("click", leaveRoom);
$("closeRoom").addEventListener("click", closeRoom);
$("muteButton").addEventListener("click", () => {
  manuallyMuted = !manuallyMuted;
  $("muteButton").textContent = manuallyMuted ? "Mikrofon kilidini aç" : "Mikrofonu kilitle";
  if (manuallyMuted) releaseTalk();
  syncMicState();
});
$("enableAudioButton").addEventListener("click", async () => {
  if (!liveKitRoom) return;
  try {
    await liveKitRoom.startAudio();
    $("enableAudioButton").classList.add("hidden");
    message("roomMsg", "Ses etkinleştirildi.");
  } catch (error) {
    message("roomMsg", `Ses etkinleştirilemedi: ${errorText(error)}`);
  }
});
$("retryVoiceButton").addEventListener("click", () => connectVoice().catch(() => {}));

const talkButton = $("talkButton");
talkButton.addEventListener("pointerdown", event => {
  event.preventDefault();
  if (event.isPrimary) talkButton.setPointerCapture?.(event.pointerId);
  startTalking(event);
});
["pointerup", "pointercancel", "lostpointercapture"].forEach(eventName =>
  talkButton.addEventListener(eventName, releaseTalk));
talkButton.addEventListener("keydown", event => {
  if ((event.code === "Space" || event.code === "Enter") && !event.repeat) {
    event.preventDefault();
    startTalking();
  }
});
talkButton.addEventListener("keyup", event => {
  if (event.code === "Space" || event.code === "Enter") releaseTalk();
});
window.addEventListener("blur", releaseTalk);
document.addEventListener("visibilitychange", () => { if (document.hidden) releaseTalk(); });

if (inviteFromUrl) $("inviteCode").value = inviteCode(inviteFromUrl);

(async () => {
  try {
    const credential = await signInAnonymously(auth);
    user = credential.user;
    $("createRoom").disabled = false;
    $("requestJoin").disabled = false;
    message("welcomeMsg", "Bağlantı hazır. Bir oda oluştur veya davet koduyla katıl.");
  } catch (error) {
    message("welcomeMsg", `Firebase kimlik doğrulaması başarısız: ${errorText(error)}`);
    $("createRoom").disabled = true;
    $("requestJoin").disabled = true;
  }
})();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
