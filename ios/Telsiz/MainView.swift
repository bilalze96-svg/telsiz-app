import SwiftUI

struct MainView: View {
    @StateObject private var radio = RadioService.shared
    @State private var name = UserDefaults.standard.string(forKey: "telsiz-name") ?? ""
    @State private var pressed = false
    @State private var emergencyPressing = false

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.12, blue: 0.11).ignoresSafeArea()
            VStack(spacing: 22) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("TELSİZ").font(.system(size: 22, weight: .black, design: .rounded)).tracking(3)
                        Text("GENEL KANAL").font(.system(size: 10, weight: .bold, design: .rounded)).tracking(2).foregroundStyle(.mint)
                    }
                    Spacer()
                    Text(radio.status.uppercased())
                        .font(.system(size: 10, weight: .heavy, design: .rounded))
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.white.opacity(0.08), in: Capsule())
                }
                .foregroundStyle(.white)

                if radio.isJoined {
                    VStack(spacing: 8) {
                        Text("\(radio.members.count)/10 KANALDA")
                            .font(.system(size: 12, weight: .bold, design: .rounded)).foregroundStyle(.mint)
                        ForEach(radio.members.prefix(10)) { member in
                            HStack {
                                Text(member.name)
                                Spacer()
                                Text(member.talking ? "KONUŞUYOR" : "BAĞLI")
                                    .font(.system(size: 9, weight: .heavy, design: .rounded))
                                    .foregroundStyle(member.talking ? .mint : .white.opacity(0.55))
                            }
                            .font(.system(size: 14, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white).padding(.vertical, 8)
                            Divider().overlay(.white.opacity(0.1))
                        }
                    }
                    .padding(18)
                    .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20))

                    Button {} label: {
                        VStack(spacing: 8) {
                            Image(systemName: "waveform")
                                .font(.system(size: 38, weight: .bold))
                            Text(pressed ? "KONUŞUYORSUN" : "BASILI TUT, KONUŞ")
                                .font(.system(size: 12, weight: .black, design: .rounded)).tracking(1)
                            Text("iPhone kilit ekranında sistem PTT düğmesini kullan")
                                .font(.system(size: 10, weight: .medium, design: .rounded))
                        }
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity).frame(height: 190)
                        .background(pressed ? Color.orange : Color.mint, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in
                                guard !pressed else { return }
                                pressed = true
                                radio.requestTransmit()
                            }
                            .onEnded { _ in
                                pressed = false
                                radio.stopTransmit()
                            }
                    )
                    .disabled(radio.isReceiving)

                    Button("KANALDAN ÇIK") { radio.leave() }
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white.opacity(0.7))

                    emergencyButton
                } else {
                    Spacer(minLength: 12)
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 54, weight: .medium)).foregroundStyle(.mint)
                    Text("Katıl. Bas, konuş.")
                        .font(.system(size: 31, weight: .black, design: .rounded)).foregroundStyle(.white)
                    Text("Ekiptekilerle aynı genel kanala bağlan.")
                        .font(.system(size: 14, weight: .medium, design: .rounded)).foregroundStyle(.white.opacity(0.7))
                    TextField("Adın", text: $name)
                        .textContentType(.nickname)
                        .textInputAutocapitalization(.words)
                        .padding(15)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(.white)
                        .onChange(of: name) { _, value in UserDefaults.standard.set(value, forKey: "telsiz-name") }
                    Button {
                        UserDefaults.standard.set(name, forKey: "telsiz-name")
                        Task { await radio.join(name: name) }
                    } label: {
                        Text("KANALA KATIL  →")
                            .font(.system(size: 13, weight: .black, design: .rounded)).tracking(1)
                            .frame(maxWidth: .infinity).padding(17)
                            .foregroundStyle(.black).background(.mint, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    emergencyButton
                    Spacer()
                }
                Spacer(minLength: 6)
                Text("Ses kaydı alınmaz · En fazla 10 kişi")
                    .font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.white.opacity(0.45))
            }
            .padding(22)
        }
        .preferredColorScheme(.dark)
    }

    private var emergencyButton: some View {
        VStack(spacing: 7) {
            Button {
                radio.enableEmergencyNotifications()
            } label: {
                Label("ACİL BİLDİRİMLERİ AÇ", systemImage: "bell.badge")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.white.opacity(0.09), in: Capsule())
            }
            Button {} label: {
                Label(emergencyPressing ? "BIRAKMA · GÖNDERİLİYOR" : "ACİL DURUM · 3 SN BASILI TUT", systemImage: "sos.circle.fill")
                    .font(.system(size: 11, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity).padding(13)
                    .background(Color.red.opacity(emergencyPressing ? 0.95 : 0.72), in: RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .onLongPressGesture(minimumDuration: 3, maximumDistance: 40, pressing: { emergencyPressing = $0 }) {
                emergencyPressing = false
                radio.sendEmergencyAlert(name: name)
            }
            Text(radio.message).font(.system(size: 10, weight: .medium, design: .rounded)).foregroundStyle(.orange)
        }
    }
}
