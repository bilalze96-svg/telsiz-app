# TELSİZ

Tek sabit bağlantı, tek genel kanal: adını yazıp gir, basılı tutup konuş. Küçük ve eğlencesine bir ekip telsizi.

## Nasıl çalışır?

- Firebase Anonymous Authentication isimsiz oturum açar; Firestore kanaldaki kişileri ve WebRTC bağlantı sinyallerini taşır.
- Ses, tarayıcılar arasında doğrudan WebRTC ile gider. Ses kaydı ve sohbet yoktur.
- Konuşmak için düğmeyi basılı tut; bırakınca mikrofon sessize alınır. Karşıya giden sese telsiz için dar bant filtresi ve kısa PTT bip'i uygulanır.
- Konuşma başlangıcı bildirimi için “Bildirimleri aç” düğmesine bas. iPhone’da önce Ana Ekran’a eklemek ve bildirime izin vermek gerekir.
- Ekran kilitlenince veya uygulamadan çıkınca mikrofon kapatılır ve kanaldan ayrılınır. Uygulama yeniden açılınca tekrar katıl.
- Uygulama tamamen kapalıyken uzaktan bildirim gönderimi kurulu değildir.
- Arayüz en fazla 10 kişi gösterir. Bu basit sürümde sayı sunucu tarafında zorlanmaz.
- Yalnızca STUN kullanılır, TURN yoktur. Bazı mobil veya kurumsal ağlarda bağlantı kurulamaması mümkündür. Acil iletişim için kullanmayın.
- iPhone’da Safari ile açın ve mikrofon izni verin. Bildirim izni için paylaşım menüsünden Ana Ekran’a ekleyip TELSİZ’i simgesinden açın.

## Proje

Firebase projesi: `telsiz-app-88ecf`. Anonymous sign-in etkin, Firestore veritabanı kimliği `default` (`europe-west3`). `firebase.json` ve istemci mevcut veritabanını hedefler.

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
