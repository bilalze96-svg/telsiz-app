# TELSİZ

Tek sabit bağlantı, tek genel kanal: adını yazıp gir, basılı tutup konuş. Küçük ve eğlencesine bir ekip telsizi.

## Nasıl çalışır?

- Firebase Anonymous Authentication isimsiz oturum açar; Firestore kanaldaki kişileri ve WebRTC bağlantı sinyallerini taşır.
- Ses, tarayıcılar arasında doğrudan WebRTC ile gider. Ses kaydı ve sohbet yoktur.
- Konuşmak için düğmeyi basılı tut; bırakınca mikrofon sessize alınır. Karşıya giden sese dar bant filtresi, belirgin sıkıştırma, kısa PTT çift bip'i ve cızırtı uygulanır.
- Bildirim için “Bildirimleri aç” düğmesine bas; izin verince deneme bildirimi gelir. iPhone’da önce Ana Ekran’a eklemek ve TELSİZ’i simgesinden açmak gerekir.
- Arka plana geçince mikrofon susturulur ve WebRTC oturumu bilerek kapatılmaz. iOS sayfayı askıya alırsa bağlantı geçici olarak düşebilir; uygulamaya dönünce oturum ve mikrofon yeniden bağlanmayı dener. iPhone ekran kilitliyken canlı sesin sürmesi Safari/PWA tarafından garanti edilmez.
- Uygulama tamamen kapalıyken uzaktan bildirim gönderimi kurulu değildir.
- Arayüz en fazla 10 kişi gösterir. Bu basit sürümde sayı sunucu tarafında zorlanmaz.
- Twilio Network Traversal Service için kısa ömürlü TURN kimlik bilgileri Cloud Function üzerinden alınır; kimlik bilgisi yoksa istemci STUN ile devam eder. TURN relay trafiği hizmet sağlayıcı maliyetine tabidir.
- iPhone’da Safari ile açın ve mikrofon izni verin. Bildirim izni için paylaşım menüsünden Ana Ekran’a ekleyip TELSİZ’i simgesinden açın.

## Proje

Firebase projesi: `telsiz-app-88ecf`. Anonymous sign-in etkin, Firestore veritabanı kimliği `default` (`europe-west3`). `firebase.json` ve istemci mevcut veritabanını hedefler.

## Yerel iPhone uygulaması

`ios/` altında iOS 17+ için SwiftUI uygulaması bulunur. Apple Push to Talk sistem arayüzünü kullanır; ekran kilitliyken gelen konuşmaların uygulamayı uyandırması için PTT APNs sunucu fonksiyonu da `functions/` altındadır. Acil durum düğmesi üç saniye basılı tutulunca kayıtlı iOS cihazlarına bildirim gönderir. Alıcılar uygulamada bir kez “Acil bildirimleri aç” seçeneğini kullanmalıdır; Firebase Anonymous oturumu ve isim cihazda saklanır.

Derlemek için macOS, Xcode 26.2+, XcodeGen ve Apple Developer hesabında Push to Talk/APNs capability ve provisioning gerekir. GitHub Actions yalnızca imzasız iOS Simulator derlemesi yapar. Apple APNs P8 anahtarını Firebase Console > Project Settings > Cloud Messaging'e ekleyin. PTT uyanma push'ı için aynı anahtarı Secret Manager'a `firebase functions:secrets:set TELSIZ_APNS_AUTH_KEY --project telsiz-app-88ecf` ile kaydedin; dağıtım sırasında `TELSIZ_APNS_KEY_ID` ve `TELSIZ_APPLE_TEAM_ID` değerlerini girin. Twilio hesabından Account SID ve Auth Token alıp `TELSIZ_TWILIO_ACCOUNT_SID` ile `TELSIZ_TWILIO_AUTH_TOKEN` olarak ayarlayın. Sonra `firebase deploy --only functions --project telsiz-app-88ecf` çalıştırın. İmza anahtarı veya servis hesabı anahtarı repoya konmaz.

Arka planda PTT ve acil durum bildirimi ile TURN yedeği için Firebase Functions'ın Blaze planında dağıtılması, Twilio hesabının tanımlanması, APNs ayarlarının yapılması ve Apple PTT entitlement'ı olan imzalı uygulamanın iki gerçek iPhone'da denenmesi gerekir. APNs/Twilio anahtarlarını kaynak koda koymayın. Bu adımlar yapılana kadar native iPhone uygulaması test edilmemiş prototiptir; mevcut web sürümü yayında kalır.

Yerelde çalıştırmak için Node.js 24 veya üstü ve Java 21 kurulu olsun:

```sh
npm ci
npm run dev
```

Otomatik kontroller:

```sh
npm run validate
```

Kurallar Firestore Emulator’da denenir. Yayın için:

```sh
npm run build
firebase deploy --only hosting,firestore:rules --project telsiz-app-88ecf
```

## Canlı durum

Site: [https://telsiz-app-88ecf.web.app](https://telsiz-app-88ecf.web.app)

Bu hafif sürüm Firebase Functions veya LiveKit kullanmaz; Firebase’de faturalandırma hesabı bağlamadan oda ve PTT akışını çalıştırmayı dener. Gerçek iki iPhone testi yapılmadı. WebRTC erişimi, kullanılan ağların doğrudan bağlantıya izin vermesine bağlıdır.
