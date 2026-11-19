# TELSİZ

Mobil uyumlu, Firebase tabanlı ekip ses odası prototipi.

## Bu sürümde
- Firebase anonim oturum açma
- Oda oluşturma ve paylaşılabilir davet bağlantısı
- Odaya katılma isteği ve oda sahibinin onay/red işlemi
- Onaylı katılımcılar arasında WebRTC ses aktarımı (mesh)
- Basılı tutarak konuşma; kayıt özelliği yok
- iPhone Safari için PWA kabuğu

## Firebase kurulumu
Firebase projesi: `telsiz-app-88ecf`
1. Authentication > Sign-in method > Anonymous açık olmalı.
2. Firestore Database oluşturulmuş olmalı.
3. Firestore Rules ekranına bu depodaki `firestore.rules` dosyasının içeriğini yapıştırıp Publish edin.
4. GitHub Pages veya başka bir HTTPS statik barındırma sağlayıcısı üzerinden yayınlayın.

## Ses ağı ve sınırlar
Bu prototip WebRTC mesh + genel STUN sunucuları kullanır. TURN sunucusu eklenmediği için bazı mobil operatör, kurumsal Wi-Fi ve NAT ağlarında ses bağlantısı kurulmayabilir. 5–10 kişilik grupta mesh bağlantısı cihaz/ağ performansına bağlıdır; üretim için yönetilen TURN veya SFU (ör. LiveKit Cloud) önerilir. iOS'ta uygulama arka planda veya ekran kilitliyken telsiz çalışması garanti edilmez.

## Test
GitHub Actions `.github/workflows/validate.yml` JavaScript sözdizimini, web manifestini ve gerekli dosyaları kontrol eder. Bu statik kontroldür; gerçek Firebase ve iki cihazlı WebRTC testi yerine geçmez.

## Gizlilik
Uygulama ses kaydı oluşturmaz. Ses, WebRTC ile canlı olarak katılımcılar arasında taşınır.
