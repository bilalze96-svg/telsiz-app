import AVFoundation
import AVFAudio
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions
import FirebaseMessaging
import Foundation
import PushToTalk
import SwiftUI
import UIKit
import UserNotifications
import WebRTC

struct RadioMember: Identifiable {
    let id: String
    let name: String
    let talking: Bool
    let lastSeen: Date
}

@MainActor
final class RadioService: NSObject, ObservableObject {
    static let shared = RadioService()
    static let channelUUID = UUID(uuidString: "f4299534-5b64-4cba-8e55-d5cc9022e60a")!
    static let channelDescriptor = PTChannelDescriptor(
        name: "TELSİZ Genel Kanal",
        image: UIImage(systemName: "dot.radiowaves.left.and.right")
    )

    @Published private(set) var status = "HAZIR"
    @Published private(set) var message = ""
    @Published private(set) var isJoined = false
    @Published private(set) var isReceiving = false
    @Published private(set) var members: [RadioMember] = []

    private let database = Firestore.firestore(database: "default")
    private let factory = RTCPeerConnectionFactory()
    private var iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
    private var channelManager: PTChannelManager?
    private var authUser: User?
    private var sessionId = ""
    private var displayName = ""
    private var localAudioTrack: RTCAudioTrack?
    private var peers: [String: NativePeer] = [:]
    private var bufferedSignals: [String: [(DocumentReference, [String: Any])]] = [:]
    private var memberListener: ListenerRegistration?
    private var inboxListener: ListenerRegistration?
    private var heartbeatTimer: Timer?
    private var pushToken: Data?
    private var notificationToken = ""
    private var joining = false

    private override init() {
        super.init()
    }

    func preparePushToTalk() async {
        guard channelManager == nil else { return }
        do {
            channelManager = try await PTChannelManager.channelManager(
                delegate: self,
                restorationDelegate: self
            )
            status = "HAZIR"
            if channelManager?.activeChannelUUID == Self.channelUUID,
               let savedName = UserDefaults.standard.string(forKey: "telsiz-name") {
                await restore(name: savedName)
            }
        } catch {
            message = "iOS PTT başlatılamadı: \(error.localizedDescription)"
            status = "HATA"
        }
    }

    func join(name: String) async {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "<", with: "")
            .replacingOccurrences(of: ">", with: "")
            .prefix(24)
        guard !cleanName.isEmpty, !joining, !isJoined else { return }
        joining = true
        displayName = String(cleanName)
        message = "Kanala bağlanıyor…"
        status = "BAĞLANIYOR"

        do {
            if channelManager == nil { await preparePushToTalk() }
            guard let channelManager else { throw RadioError.pttUnavailable }
            guard await requestMicrophonePermission() else { throw RadioError.microphoneDenied }
            authUser = try await anonymousUser()
            await refreshIceServers()
            try await createFirebaseSession()
            channelManager.requestJoinChannel(
                channelUUID: Self.channelUUID,
                descriptor: Self.channelDescriptor
            )
            if let pushToken { try await storePushToken(pushToken) }
            if UserDefaults.standard.bool(forKey: "telsiz-notifications-enabled"), !notificationToken.isEmpty {
                try await storeNotificationToken(notificationToken)
            }
        } catch {
            await removeFirebaseSession()
            message = error.localizedDescription
            status = "HATA"
            joining = false
        }
    }

    private func restore(name: String) async {
        guard !joining, !isJoined else { return }
        joining = true
        displayName = name
        do {
            authUser = try await anonymousUser()
            await refreshIceServers()
            try await createFirebaseSession()
            if let pushToken { try await storePushToken(pushToken) }
            isJoined = true
            joining = false
            startWatching()
            status = "KANALDA"
            try await channelManager?.setServiceStatus(.ready, channelUUID: Self.channelUUID)
        } catch {
            message = "Kanal geri yüklenemedi: \(error.localizedDescription)"
            joining = false
        }
    }

    private func createFirebaseSession() async throws {
        guard let authUser else { throw RadioError.notSignedIn }
        sessionId = UUID().uuidString.lowercased()
        let reference = database.collection("members").document(sessionId)
        try await reference.setData([
            "uid": authUser.uid,
            "name": displayName,
            "joinedAt": FieldValue.serverTimestamp(),
            "lastSeen": FieldValue.serverTimestamp(),
            "talking": false
        ])
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        localAudioTrack = factory.audioTrack(with: source, trackId: "telsiz-audio-\(sessionId)")
        localAudioTrack?.isEnabled = false
    }

    private func anonymousUser() async throws -> User {
        if let currentUser = Auth.auth().currentUser { return currentUser }
        return try await Auth.auth().signInAnonymously().user
    }

    private func requestMicrophonePermission() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .denied, .restricted: return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
            }
        @unknown default: return false
        }
    }

    private func refreshIceServers() async {
        iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        do {
            let result = try await Functions.functions(region: "europe-west3")
                .httpsCallable("getTurnCredentials")
                .call()
            guard let payload = result.data as? [String: Any],
                  let records = payload["iceServers"] as? [[String: Any]] else { return }
            let configured = records.compactMap { record -> RTCIceServer? in
                let urls: [String]
                if let list = record["urls"] as? [String] { urls = list }
                else if let url = record["urls"] as? String { urls = [url] }
                else { return nil }
                guard !urls.isEmpty else { return nil }
                return RTCIceServer(
                    urlStrings: urls,
                    username: record["username"] as? String ?? "",
                    credential: record["credential"] as? String ?? ""
                )
            }
            if configured.contains(where: { $0.urlStrings.contains(where: { $0.hasPrefix("turn:") }) }) {
                iceServers = configured
            }
        } catch {
            message = "TURN yedeği kapalı; bazı ağlarda bağlantı kurulamayabilir."
        }
    }

    private func startWatching() {
        memberListener?.remove()
        inboxListener?.remove()
        memberListener = database.collection("members")
            .order(by: "lastSeen", descending: true)
            .limit(to: 15)
            .addSnapshotListener { [weak self] snapshot, error in
            Task { @MainActor in
                guard let self else { return }
                if let error { self.message = "Kanal bağlantısı: \(error.localizedDescription)"; return }
                let now = Date()
                self.members = (snapshot?.documents ?? []).compactMap { document in
                    let data = document.data()
                    guard let name = data["name"] as? String,
                          let lastSeen = (data["lastSeen"] as? Timestamp)?.dateValue(),
                          now.timeIntervalSince(lastSeen) < 45 else { return nil }
                    return RadioMember(id: document.documentID, name: name, talking: data["talking"] as? Bool ?? false, lastSeen: lastSeen)
                }.sorted { $0.lastSeen < $1.lastSeen }
                for member in self.members where member.id != self.sessionId {
                    self.addPeerIfNeeded(id: member.id)
                }
                let online = Set(self.members.map(\.id))
                for id in self.peers.keys where !online.contains(id) { self.closePeer(id) }
                if let activeSpeaker = self.members.first(where: { $0.talking && $0.id != self.sessionId }) {
                    self.setReceiving(true, speaker: activeSpeaker.name)
                } else {
                    self.setReceiving(false, speaker: nil)
                }
            }
        }
        inboxListener = database.collection("members").document(sessionId).collection("inbox")
            .addSnapshotListener { [weak self] snapshot, error in
                Task { @MainActor in
                    guard let self else { return }
                    if let error { self.message = "Sinyal bağlantısı: \(error.localizedDescription)"; return }
                    for change in snapshot?.documentChanges ?? [] where change.type == .added {
                        let data = change.document.data()
                        let fromSession = data["fromSession"] as? String ?? ""
                        let reference = change.document.reference
                        if let peer = self.peers[fromSession] { peer.handle(reference: reference, signal: data) }
                        else { self.bufferedSignals[fromSession, default: []].append((reference, data)) }
                    }
                }
            }
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isJoined else { return }
                self.database.collection("members").document(self.sessionId)
                    .updateData(["lastSeen": FieldValue.serverTimestamp()])
            }
        }
    }

    private func addPeerIfNeeded(id: String) {
        guard peers[id] == nil, let localAudioTrack else { return }
        var configuration = RTCConfiguration()
        configuration.iceServers = iceServers
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = factory.peerConnection(with: configuration, constraints: constraints, delegate: nil) else { return }
        let peer = NativePeer(id: id, connection: connection, service: self)
        peers[id] = peer
        connection.delegate = peer
        connection.add(localAudioTrack, streamIds: ["telsiz-stream"])
        let pending = bufferedSignals.removeValue(forKey: id) ?? []
        pending.forEach { peer.handle(reference: $0.0, signal: $0.1) }
        if sessionId < id { peer.createOffer() }
    }

    func sendSignal(to peerId: String, kind: String, payload: [String: Any]) {
        guard let authUser, !sessionId.isEmpty else { return }
        let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
        let encoded = String(data: data, encoding: .utf8) ?? "{}"
        database.collection("members").document(peerId).collection("inbox").addDocument(data: [
            "fromSession": sessionId,
            "fromUid": authUser.uid,
            "toSession": peerId,
            "kind": kind,
            "payload": encoded,
            "createdAt": FieldValue.serverTimestamp()
        ])
    }

    func updateTalking(_ talking: Bool) {
        localAudioTrack?.isEnabled = talking
        guard !sessionId.isEmpty else { return }
        database.collection("members").document(sessionId).updateData([
            "talking": talking,
            "lastSeen": FieldValue.serverTimestamp()
        ]) { [weak self] error in
            if let error { Task { @MainActor in self?.message = error.localizedDescription } }
        }
    }

    func requestTransmit() {
        guard isJoined, !isReceiving else { return }
        channelManager?.requestBeginTransmitting(channelUUID: Self.channelUUID)
    }

    func stopTransmit() {
        channelManager?.stopTransmitting(channelUUID: Self.channelUUID)
    }

    func enableEmergencyNotifications() {
        Task {
            let center = UNUserNotificationCenter.current()
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                guard granted else {
                    UserDefaults.standard.set(false, forKey: "telsiz-notifications-enabled")
                    message = "iPhone Ayarları > Bildirimler > TELSİZ bölümünden bildirimleri aç."
                    return
                }
                UserDefaults.standard.set(true, forKey: "telsiz-notifications-enabled")
                await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
                authUser = try await anonymousUser()
                if !notificationToken.isEmpty { try await storeNotificationToken(notificationToken) }
                message = "Acil durum bildirimleri açık."
            } catch {
                message = "Bildirim izni açılamadı: \(error.localizedDescription)"
            }
        }
    }

    func sendEmergencyAlert(name: String) {
        Task {
            do {
                authUser = try await anonymousUser()
                let cleanName = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(24))
                guard !cleanName.isEmpty else { throw RadioError.missingName }
                let result = try await Functions.functions(region: "europe-west3")
                    .httpsCallable("sendEmergencyAlert")
                    .call(["name": cleanName])
                let payload = result.data as? [String: Any] ?? [:]
                let registered = payload["registered"] as? Int ?? 0
                let accepted = payload["delivered"] as? Int ?? 0
                message = accepted == 0
                    ? (registered == 0 ? "Kayıtlı alıcı cihaz bulunamadı." : "Bildirim servisi bu kez hiçbir cihazı kabul etmedi.")
                    : "Acil bildirim \(accepted) cihaza iletilmek üzere kuyruğa alındı."
            } catch {
                message = "Acil durum bildirimi gönderilemedi: \(error.localizedDescription)"
            }
        }
    }

    func setNotificationError(_ text: String) {
        message = "Bildirim kaydı başarısız: \(text)"
    }

    func leave() {
        channelManager?.leaveChannel(channelUUID: Self.channelUUID)
    }

    private func setReceiving(_ receiving: Bool, speaker: String?) {
        guard isReceiving != receiving else { return }
        isReceiving = receiving
        guard let channelManager else { return }
        let participant = speaker.map { PTParticipant(name: $0, image: nil) }
        channelManager.setActiveRemoteParticipant(participant, channelUUID: Self.channelUUID) { error in
            if let error { Task { @MainActor in self.message = error.localizedDescription } }
        }
    }

    private func closePeer(_ id: String) {
        peers.removeValue(forKey: id)?.close()
    }

    private func removeFirebaseSession() async {
        memberListener?.remove(); memberListener = nil
        inboxListener?.remove(); inboxListener = nil
        heartbeatTimer?.invalidate(); heartbeatTimer = nil
        for id in Array(peers.keys) { closePeer(id) }
        guard !sessionId.isEmpty else { return }
        if let authUser {
            try? await database.collection("pttTokens").document(authUser.uid).delete()
        }
        try? await database.collection("members").document(sessionId).delete()
        sessionId = ""
        isJoined = false
        isReceiving = false
        members = []
    }

    private func storePushToken(_ token: Data) async throws {
        guard let authUser, !sessionId.isEmpty else { return }
        let environment = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "sandbox" : "production"
        try await database.collection("pttTokens").document(authUser.uid).setData([
            "uid": authUser.uid,
            "sessionId": sessionId,
            "token": token.map { String(format: "%02x", $0) }.joined(),
            "environment": environment,
            "updatedAt": FieldValue.serverTimestamp()
        ])
    }

    private func storeNotificationToken(_ token: String) async throws {
        guard let authUser, !token.isEmpty else { return }
        try await database.collection("pushDevices").document(authUser.uid).setData([
            "uid": authUser.uid,
            "token": token,
            "updatedAt": FieldValue.serverTimestamp()
        ])
    }
}

extension RadioService: PTChannelManagerDelegate, PTChannelRestorationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken, !fcmToken.isEmpty else { return }
        Task { @MainActor in
            notificationToken = fcmToken
            guard UserDefaults.standard.bool(forKey: "telsiz-notifications-enabled") else { return }
            if Auth.auth().currentUser == nil { return }
            authUser = Auth.auth().currentUser
            try? await storeNotificationToken(fcmToken)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
        Self.channelDescriptor
    }

    func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
        self.pushToken = pushToken
        guard isJoined else { return }
        Task { try? await storePushToken(pushToken) }
    }

    func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {
        guard channelUUID == Self.channelUUID else { return }
        isJoined = true
        joining = false
        status = "KANALDA"
        message = "Hazır. Basılı tutup konuş."
        startWatching()
        Task { try? await channelManager.setServiceStatus(.ready, channelUUID: channelUUID) }
    }

    func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
        guard channelUUID == Self.channelUUID else { return }
        updateTalking(false)
        Task {
            await removeFirebaseSession()
            joining = false
            status = "HAZIR"
            message = "Kanaldan ayrıldın."
        }
    }

    func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: Error) {
        message = "PTT kanalına girilemedi: \(error.localizedDescription)"
        status = "HATA"
        joining = false
        Task { await removeFirebaseSession() }
    }

    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
        guard channelUUID == Self.channelUUID else { return }
        let session = RTCAudioSession.sharedInstance()
        session.isAudioEnabled = true
        updateTalking(true)
        status = "KONUŞUYOR"
    }

    func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
        guard channelUUID == Self.channelUUID else { return }
        updateTalking(false)
        status = "KANALDA"
    }

    func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
        RTCAudioSession.sharedInstance().isAudioEnabled = true
    }

    func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }

    func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
        guard channelUUID == Self.channelUUID,
              let name = pushPayload["activeSpeaker"] as? String else { return .leaveChannel }
        Task { @MainActor in
            if !isJoined, let savedName = UserDefaults.standard.string(forKey: "telsiz-name") {
                await restore(name: savedName)
            }
            status = "\(name.uppercased()) KONUŞUYOR"
        }
        return .activeRemoteParticipant(PTParticipant(name: name, image: nil))
    }
}

private enum RadioError: LocalizedError {
    case pttUnavailable
    case notSignedIn
    case microphoneDenied
    case missingName
    var errorDescription: String? {
        switch self {
        case .pttUnavailable: "iOS Push to Talk servisi kullanılamıyor."
        case .notSignedIn: "Firebase oturumu açılamadı."
        case .microphoneDenied: "Mikrofon izni gerekli. iPhone Ayarları > TELSİZ bölümünden aç."
        case .missingName: "Önce adını gir."
        }
    }
}
