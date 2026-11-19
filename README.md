# TELSİZ — web uygulaması başlangıç paketi

## Önemli durum
Bu paket, TELSİZ'in mobil uyumlu arayüzünü ve PWA kabuğunu içerir. **Henüz gerçek odalar, davet onayı veya kişiler arası ses aktarımı çalışır durumda değildir.** Bu özellikleri güvenli biçimde açmak için Firebase projesi (kimlik doğrulama + Firestore sinyalleşme) ve WebRTC bağlantı kurulumu gerekir.

## Mimari
- İstemci: HTML, CSS, JavaScript (PWA)
- Oda/katılma talepleri: Firebase Authentication (anonim) + Firestore
- Canlı ses: WebRTC, ses kaydı olmadan
- 5–10 katılımcı: küçük ekip için mesh bağlantısı denenebilir; mobil ağlarda TURN servisi gerekebilir.
- Üretim ortamı: HTTPS zorunludur.

## Çalıştırma
Dosyaları HTTPS destekleyen bir statik barındırma hizmetine yükleyin. Yerelde test için bir statik sunucu kullanın; `file://` ile açmayın.

## Gerekli sonraki adım
1. Firebase Console'da proje oluşturun.
2. Authentication > Sign-in method bölümünde Anonymous girişini açın.
3. Firestore Database oluşturun.
4. Web uygulaması kaydedip Firebase web config değerlerini alın.
5. `app.js` içindeki `firebaseConfig` alanlarına gerçek değerleri yerleştirin.
6. Firestore güvenlik kuralları; oda sahibi, bekleyen katılımcı ve onaylanmış katılımcı rollerini doğrulayacak şekilde yazılmalı. Şu anki kurallar bilerek tüm erişimi kapatır.
7. Ardından oda oluşturma, katılma isteği/onay akışı, WebRTC offer/answer/ICE sinyalleşmesi ve TURN yapılandırması eklenecek.

## iPhone notu
Safari mikrofon erişimi için HTTPS gerekir. PWA ana ekrana eklenebilir; ancak iOS'ta arka planda/ekran kilitliyken sürekli telsiz davranışı garanti edilemez. İlk sürüm uygulama açıkken çalışacak şekilde hedeflenmelidir.

## Gizlilik
Bu tasarım ses kaydı tutmaz. Ancak canlı ses paketleri internet üzerinden katılımcılara taşınır; sesin hiç işlenmediği veya ağ altyapısında hiçbir geçici aktarım olmadığı anlamına gelmez. Katılım bağlantıları tahmin edilemez olmalı ve oda sahibi onayı sunucu tarafında doğrulanmalıdır.
