import Foundation
import FirebaseFirestore
import WebRTC

@MainActor
final class NativePeer: NSObject, RTCPeerConnectionDelegate {
    let id: String
    let connection: RTCPeerConnection
    weak var service: RadioService?
    private var pendingCandidates: [RTCIceCandidate] = []
    private let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

    init(id: String, connection: RTCPeerConnection, service: RadioService) {
        self.id = id
        self.connection = connection
        self.service = service
        super.init()
    }

    func createOffer() {
        connection.offer(for: constraints) { [weak self] offer, error in
            guard let self, let offer, error == nil else { return }
            self.connection.setLocalDescription(offer) { [weak self] error in
                guard let self, error == nil else { return }
                self.service?.sendSignal(to: self.id, kind: "offer", payload: ["type": "offer", "sdp": offer.sdp])
            }
        }
    }

    func handle(reference: DocumentReference, signal: [String: Any]) {
        let kind = signal["kind"] as? String ?? ""
        let payload = signal["payload"] as? String ?? "{}"
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch kind {
        case "offer":
            guard let sdp = object["sdp"] as? String else { return }
            let description = RTCSessionDescription(type: .offer, sdp: sdp)
            connection.setRemoteDescription(description) { [weak self] error in
                guard let self, error == nil else { return }
                self.connection.answer(for: self.constraints) { [weak self] answer, error in
                    guard let self, let answer, error == nil else { return }
                    self.connection.setLocalDescription(answer) { [weak self] error in
                        guard let self, error == nil else { return }
                        self.service?.sendSignal(to: self.id, kind: "answer", payload: ["type": "answer", "sdp": answer.sdp])
                        self.addPendingCandidates()
                    }
                }
            }
        case "answer":
            guard let sdp = object["sdp"] as? String else { return }
            connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
                guard error == nil else { return }
                self?.addPendingCandidates()
            }
        case "candidate":
            guard let candidate = object["candidate"] as? String else { return }
            let mid = object["sdpMid"] as? String
            let line = (object["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
            let ice = RTCIceCandidate(sdp: candidate, sdpMLineIndex: line, sdpMid: mid)
            if connection.remoteDescription != nil { connection.add(ice) }
            else { pendingCandidates.append(ice) }
        default:
            break
        }
        reference.delete()
    }

    private func addPendingCandidates() {
        let queued = pendingCandidates
        pendingCandidates.removeAll()
        queued.forEach { connection.add($0) }
    }

    func close() { connection.close() }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        service?.sendSignal(to: id, kind: "candidate", payload: [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid as Any? ?? NSNull(),
            "sdpMLineIndex": candidate.sdpMLineIndex
        ])
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
