# TELSİZ

Firebase ile oda ve katılımcı onayı, LiveKit Cloud ile 5–10 kişilik canlı ekip sesi sunan iPhone Safari ve PWA uygulaması. Ses tarayıcıdan canlı aktarılır; uygulama ses kaydı oluşturmaz.

## Mimari

- Firebase Anonymous Authentication ile kullanıcı oturumu.
- Firestore oda, katılımcı ve onay durumunu tutar. Davet kodları 12 karakterli rastgele kimliklerdir.
- Oda sahibi katılma isteklerini onaylar veya reddeder. Onay işlemi Cloud Function içinde oda sahibi ve 10 kişilik sınır kontrolüyle yapılır.
- LiveKit Cloud SFU, ses akışını ve yönetilen TURN/TLS yedek bağlantısını sağlar. Odaya katılma token’ı yalnızca onaylı Firestore üyeliği olan anonim kullanıcıya, Cloud Function üzerinden verilir.
- LiveKit token’ı yalnızca mikrofon yayını ve dinlemeye izin verir; veri kanalı ve oda kaydı izni verilmez. API anahtarı ve gizli anahtar tarayıcı koduna konmaz.

## Firebase durumu ve kurulumu

Bu depo `telsiz-app-88ecf` projesini hedef alır. Anonymous sign-in bu projede etkin. Var olan Firestore veritabanının kimliği `default` ve konumu `europe-west3`; uygulama, Functions ve `firebase.json` bu veritabanına açıkça bağlanır. Güvenlik kuralları `default` veritabanına yayımlandı.

Cloud Functions dağıtımı için Firebase projesinin Blaze planında olması gerekir. Blaze, Cloud Billing hesabı bağlanmasını ve kullanım bazlı ücretlendirmeyi etkinleştirir. Kurallar var olan `default` veritabanına yayımlandı; projede ayrıca standart `(default)` veritabanı yok. Firebase’in istemci ve Admin SDK’larında adlandırılmış veritabanı API’si beta olarak işaretlendiğinden, bu veritabanı seçimi genel kullanıma açılmadan önce standart `(default)` veritabanına geçiş veya Firebase tarafından desteklenen bir üretim kurulumu kararı gerektirir.

1. [LiveKit Cloud](https://cloud.livekit.io/) projesi açıp proje URL’sini (`wss://...`) alın.
2. `functions/.env.telsiz-app-88ecf` dosyasına şu değeri koyun:

   ```dotenv
   LIVEKIT_URL=wss://<LiveKit-proje-adresi>
   ```

3. LiveKit API kimliğini ve gizli anahtarını Firebase Secret Manager’a ayrı ayrı girin:

   ```sh
   firebase functions:secrets:set LIVEKIT_API_KEY
   firebase functions:secrets:set LIVEKIT_API_SECRET
   ```

   Değerleri komut satırı argümanı veya istemci kodu olarak eklemeyin. Yerel sır dosyaları Git tarafından yok sayılır.

## Geliştirme ve test

Node.js 24.12 veya üstü ve Java 21 gerekir. Cloud Functions Node.js 22 çalışma zamanını kullanır.

```sh
npm ci
npm ci --prefix functions
npm run dev
```

Güvenlik kuralları Firebase Emulator’da test edilir. Bu testler üretim Firestore’una bağlanmaz:

```sh
npm run test:static
npm run build
npm run test:build
npm test --prefix functions
npm run test:rules
npm run lint --prefix functions
```

GitHub Actions bu kurulum, statik derleme, Function sözdizimi ve Firestore Rules emulator testlerini çalıştırır.

## HTTPS dağıtımı

Hosting ve Cloud Functions yapılandırması `firebase.json` içinde hazırdır. `npm run build` sonrasında HTTPS Hosting’e yayınlamak için:

```sh
firebase deploy --only hosting,functions,firestore:rules --project telsiz-app-88ecf
```

Yayın için Firebase CLI ile yetkili Google hesabında oturum açılması ve yukarıdaki LiveKit ayarlarının yapılması gerekir. Firebase Hosting iPhone mikrofon erişimi için HTTPS sağlar. Oda kuralları test edilmeden yayımlanmamalıdır.

Şu anda Hosting [https://telsiz-app-88ecf.web.app](https://telsiz-app-88ecf.web.app) adresinde yayında. Anonymous sign-in etkin ve Firestore kuralları mevcut `default` veritabanına dağıtıldı. Firebase CLI, standart `(default)` veritabanını oluştururken faturalandırma gereksinimi nedeniyle 403 döndürdü. Cloud Functions Spark planında dağıtılamaz; LiveKit URL/anahtarları da henüz yapılandırılmadı. Bu nedenle oda onayı, token üretimi, canlı ses ve gerçek iki iPhone testi tamamlanmamıştır; uygulama MVP olarak hazır değildir.

## iPhone kullanımı ve bilinen sınırlar

- Davet bağlantısını iPhone Safari’de açın; ana ekrana ekleyerek PWA olarak da kullanabilirsiniz.
- iOS, uzaktaki sesi başlatmak için kullanıcı dokunuşu isteyebilir. Gerekirse odada “Sesi etkinleştir” düğmesine dokunun.
- Konuşma düğmesi basılıyken mikrofon yayını açılır; bırakma, uygulamayı arka plana alma veya bağlantının kesilmesi mikrofonu susturur.
- iOS Safari/PWA arka plan ve ekran kilidi sırasında telsiz çalışmasını garanti etmez. Uygulamayı test boyunca ön planda tutun.
- 10 kişi kapasite ve dağıtım ayarları yapılandırılmıştır; gerçek iPhone, Safari, hücresel ağ ve iki cihazlı ses testi bu kaynak kodu değişikliğiyle yapılmış sayılmaz.

## Gizlilik

`MediaRecorder`, kayıt veya dışa aktarma özelliği yoktur. Oda sesleri LiveKit Cloud üzerinden gerçek zamanlı iletilir. Oda sahibi onaylı olmayan kullanıcıların ses token’ı almasını engeller.
