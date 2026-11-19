// TELSİZ başlangıç istemcisi. Canlı oda/ses özellikleri Firebase projesi bağlandıktan sonra etkinleştirilecektir.
const firebaseConfig = {
  apiKey: "FIREBASE_API_KEY",
  authDomain: "FIREBASE_AUTH_DOMAIN",
  projectId: "FIREBASE_PROJECT_ID",
  appId: "FIREBASE_APP_ID"
};
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const invite = params.get("room");
let displayName = "";
let roomId = "";
let isHost = false;
let localStream = null;
let isTalking = false;

function message(id, text) { $(id).textContent = text; }
function showRoom(id, host) {
  roomId = id; isHost = host;
  $("welcome").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomName").textContent = "EKİP ODASI";
  $("inviteText").textContent = `${location.origin}${location.pathname}?room=${id}`;
  $("closeRoom").classList.toggle("hidden", !host);
  $("requestsBox").classList.toggle("hidden", !host);
  $("roomState").textContent = "KURULUM GEREKLİ";
  $("talkButton").disabled = true;
  $("talkButton").querySelector("small").textContent = "Canlı ses için Firebase kurulumu bekleniyor";
  message("roomMsg", "Arayüz hazır. Gerçek oda ve ses bağlantısını açmak için README'deki Firebase kurulumunu tamamlayın.");
  renderPeople([{name:displayName,state:"Bu cihaz"}]);
}
function renderPeople(list) {
  $("people").innerHTML = "";
  list.forEach(p => {
    const li = document.createElement("li");
    const name = document.createElement("span"); name.textContent = p.name;
    const state = document.createElement("span"); state.className = "person-state"; state.textContent = p.state;
    li.append(name,state); $("people").append(li);
  });
  $("peopleCount").textContent = `${list.length} kişi`;
}
$("createRoom").addEventListener("click", () => {
  displayName = $("displayName").value.trim();
  if (!displayName) return message("welcomeMsg","Önce görünen adını yaz.");
  const id = crypto.randomUUID().replaceAll("-","").slice(0,8).toUpperCase();
  showRoom(id,true);
  history.replaceState({}, "", `?room=${id}`);
});
$("requestJoin").addEventListener("click", () => {
  displayName = $("displayName").value.trim();
  const id = $("inviteCode").value.trim().toUpperCase() || invite;
  if (!displayName) return message("welcomeMsg","Önce görünen adını yaz.");
  if (!id) return message("welcomeMsg","Davet kodunu veya bağlantısını gir.");
  showRoom(id,false);
  message("roomMsg","Katılma isteği arayüzü hazır; gerçek onay akışı Firebase bağlantısından sonra çalışacak.");
});
$("copyInvite").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("inviteText").textContent); $("copyInvite").textContent="KOPYALANDI"; }
  catch { message("roomMsg","Bağlantı kopyalanamadı. Adres çubuğundaki bağlantıyı paylaşın."); }
});
$("leaveButton").addEventListener("click", () => { localStream?.getTracks().forEach(t=>t.stop()); location.href=location.pathname; });
$("closeRoom").addEventListener("click", () => { if (!isHost) return; localStream?.getTracks().forEach(t=>t.stop()); location.href=location.pathname; });
$("muteButton").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $("muteButton").textContent = track.enabled ? "Mikrofonu kapat" : "Mikrofonu aç";
});
$("talkButton").addEventListener("pointerdown", async (e) => {
  e.preventDefault();
  if (!localStream) {
    try { localStream = await navigator.mediaDevices.getUserMedia({audio:true}); }
    catch { return message("roomMsg","Mikrofon izni verilmedi veya HTTPS bağlantısı kullanılmıyor."); }
  }
  isTalking=true; $("talkButton").classList.add("active");
});
["pointerup","pointercancel","pointerleave"].forEach(evt => $("talkButton").addEventListener(evt,()=>{
  isTalking=false; $("talkButton").classList.remove("active");
}));
if (invite) $("inviteCode").value = invite;
if ("serviceWorker" in navigator) window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));

// Güvenlik: Firebase yapılandırması ve sunucu tarafı erişim kuralları olmadan oda/ses başlatılmaz.
