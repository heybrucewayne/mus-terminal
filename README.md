# MUS / Coin Terminal

Tarayıcı içinde çalışan, salt-okunur kripto ve geleneksel piyasa terminali.

## Entegre edilen sistemler

- Crypto Bubbles: kripto varlıklar, S&P 500, NASDAQ, GOLD ve OIL aynı bubble görünümünde.
- Prices: Binance kripto fiyatları, CNBC üzerinden hisse ve geleneksel piyasa fiyatları.
- HYPE/Hyperliquid için CoinGecko fallback verisi.
- Gold için ek fiyat fallback kaynağı.
- Sembol arama ile yeni coin veya hisse ekleme.
- 24 saatlik değişim, fiyat, yüksek/düşük ve hacim bilgileri.
- Masaüstünde kaydırmasız, yan yana Bubbles + Prices görünümü.

## Çalışma sınırı

Uygulama tarayıcıda çalışır. Yerel bilgisayarda shell komutu, executable veya dosya çalıştırmaz. Wallet bağlantısı ve alım-satım işlemi yoktur. Piyasa verileri dış API/WebSocket kaynaklarından okunur; bazı veriler geçici olarak alınamazsa son başarılı değer tarayıcı cache’inden gösterilir.

## Veri kaynakları

- Binance public REST: kripto fiyatları.
- CNBC public quote endpoint: S&P 500, NASDAQ, WTI Oil, Gold ve eklenen hisseler.
- CoinGecko public API: HYPE ve ek piyasa verileri.

## Yayınlama

Proje tek bir statik `index.html` dosyasından oluşur. GitHub repository’sine bağlanan Vercel projesinde build command gerekmez; proje kökü publish directory olarak kullanılabilir.
