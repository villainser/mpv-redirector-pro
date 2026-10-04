# MPV Redirector Pro 3.4.9

Rozszerzenie Chrome tworzy gotową playlistę strumieni z załadowanej strony i
przekazuje wybraną pozycję do lokalnego MPV przez Native Messaging. Wersja 3.4.9
łączy kilka uzupełniających się sposobów wykrywania:

1. od początku ładowania agresywnie, lecz z limitami skanuje elementy audio/wideo,
   atrybuty i konfiguracje `data-*`, JSON-LD, osadzony JSON i literały URL w
   skryptach playera, metadane, preloady oraz bezpośrednie linki. Kod strony nie
   jest przy tym wykonywany;
2. obserwuje HLS, DASH, MP4, WebM i inne media w ruchu sieciowym, Resource Timing
   oraz w zmianach DOM, a po gotowości dokumentu wykonuje trzy ograniczone
   ponowienia skanu. Kosztowne przeszukiwanie osadzonego JSON/JavaScript i te
   ponowienia dotyczą tylko głównego dokumentu; ramki nadal śledzą rzeczywiste
   elementy audio/wideo oraz zasoby bez mnożenia pełnych skanów;
3. znaleziony publiczny master HLS odczytuje w tle i tworzy maksymalnie 24
   osobne warianty jakości z rozdzielczością i bitrate. Bezpośrednie
   reprezentacje DASH są dodawane tylko wtedy, gdy wskazują gotowy MP4/WebM;
4. po załadowaniu aktywnego materiału TVP z numerycznym identyfikatorem albo
   materiału YouTube automatycznie przygotowuje kompletne źródło audio+wideo.
   TVP używa kolejności Streamlink → yt-dlp, a YouTube yt-dlp → Streamlink;
   samo przygotowanie wykonuje się raz na materiał, nie uruchamia MPV i nie
   przekazuje cookies;
5. po kliknięciu **Rozpoznaj stronę** uruchamia bezpieczne resolvery
   [Streamlink](https://github.com/streamlink/streamlink) i
   [yt-dlp](https://github.com/yt-dlp/yt-dlp), w kolejności dobranej do
   platformy. Na YouTube pierwszeństwo ma yt-dlp.

Wyniki są deduplikowane i pokazują pochodzenie: **Sieć**, **Strona**,
**Manifest**, **Streamlink** lub **yt-dlp**. Na YouTube surowe ścieżki reklamowe, obce ramki,
pełne wielojęzyczne mastery, dubbingi oraz formaty tylko-audio/tylko-wideo pozostają diagnostyką i nie trafiają
do polecania, szybkiego otwierania ani M3U. Rozszerzenie odrzuca też segmenty
techniczne, odpowiedzi HTTP z błędem i materiały oznaczone jako DRM.

Domyślny porządek playlisty stawia rzeczywiste transporty wideo HLS, DASH, MP4
i WebM na początku i układa je według ustawionej jakości
2160p → 1440p → 1080p → 720p → 480p. Dopiero potem rozstrzyga pochodzenie,
kompletność i potwierdzenie transportu. Recepta resolvera zawierająca tylko URL
strony oraz nieprzezroczysty fallback pozostają na końcu. Reklama, diagnostyka,
wygasły lub wcześniej odrzucony dokładny transport i jawnie niekompletna ścieżka
audio/wideo nie mogą przejąć rekomendacji ani auto-otwierania. Rekomendacja jest
liczona osobno: kompletny master lub wynik resolvera wygrywa z wyższym wariantem
potwierdzonym wyłącznie w sesji Chrome, jeśli MPV nie dostałby jej poświadczeń.

Termin ważności jednoznacznie podpisanych URL-i jest sprawdzany przed wysłaniem
do MPV. Rozszerzenie ustawia trwały budzik Manifest V3 przed wygaśnięciem,
ponownie skanuje bieżącą stronę i uruchamia lokalny resolver bez cookies i bez
auto-odtwarzania. Błąd jednego dokładnego tokenu wycofuje tylko ten transport;
po wykryciu odświeżonego URL-a źródło automatycznie wraca na listę.

Na stronach obsługiwanych przez adapter ogólny globalny filtr reklam łączy
wspólne sygnały ad-tech z bieżącym stanem odtwarzacza. Gdy aktywny odtwarzacz
zastąpi wcześniejsze źródło kolejnym materiałem, poprzedni wpis jest wycofywany
z polecania i auto-otwierania. Filtr nie omija reklam SSAI osadzonych w tym samym
masterze HLS lub DASH, ponieważ dla MPV pozostają one częścią jednego strumienia.
Lista strony ma twardy limit 80 wpisów, ale późno znaleziony manifest, bieżące
źródło odtwarzacza lub potwierdzony zasób może wyprzeć wcześniejsze słabe trafienie.

## Wymagania

- Linux oraz Chrome/Chromium zgodny z Manifest V3;
- `mpv` dostępny w `PATH`;
- Python 3 z modułem `venv`;
- dostęp do internetu podczas pierwszej pełnej instalacji resolverów.

Instalator wymaga dla zewnętrznych narzędzi co najmniej Streamlink 8.4.0 oraz
yt-dlp 2026.06.09. Umieszcza je bez `sudo` w prywatnym środowisku:

```text
~/.local/share/mpv-redirector/resolvers
```

## Instalacja na jednym lub wielu profilach Chrome

1. Rozpakuj pakiet raz i pozostaw katalog w stałym miejscu.
2. Uruchom w nim:

```bash
./install.sh
```

3. W każdym profilu otwórz `chrome://extensions`.
4. Włącz **Tryb dewelopera**, kliknij **Załaduj rozpakowane** i wskaż ten
   sam katalog z `manifest.json`.

Host lokalny oraz resolvery instaluje się raz dla konta Linuksa i współdzieli
między profilami. Sam dodatek trzeba załadować oddzielnie w każdym profilu.
Identyfikator rozszerzenia zależy od pełnej ścieżki katalogu. Po przeniesieniu
pakietu ponownie uruchom `./install.sh`; instalator zachowuje rejestr wcześniej
autoryzowanych identyfikatorów.

Kontrola hosta i minimalnych wersji obu resolverów nie zmienia instalacji:

```bash
./install.sh --check
```

Instalacja samego hosta, bez pobierania Streamlink/yt-dlp:

```bash
./install.sh --host-only
```

W takim trybie przechwytywanie sieciowe i DOM nadal działa, ale przycisk
**Rozpoznaj stronę** zgłosi brak dodatkowych narzędzi. Po każdej aktualizacji
plików kliknij **Odśwież** przy dodatku na `chrome://extensions` w każdym
używanym profilu.

## Używanie

Najszybciej: kliknij prawym przyciskiem w zwykłe miejsce strony i wybierz
**Otwórz polecany w MPV**. Na YouTube to polecenie zawsze wykonuje świeże
rozpoznanie przez yt-dlp (ze Streamlinkiem jako fallbackiem), dzięki czemu
stary albo reklamowy adres `videoplayback` nie wygrywa z właściwym materiałem.
Na TVP bezpieczne źródło jest przygotowywane po załadowaniu aktywnego materiału.
Na pozostałych stronach rozszerzenie użyje najlepszego już wykrytego,
nie-reklamowego źródła, a resolvery uruchomi, gdy lista jest pusta.

Jeżeli MPV odrzuci pierwszy adres błędem ładowania, zakończy się tuż po starcie
albo nie otworzy demuksera w limicie, komenda PPM i ręczne kliknięcie w popupie
mogą wykonać najwyżej jedną próbę innym, kompletnym kandydatem. Alternatywa nie
może być reklamą, audio, niepełnym wariantem, wpisem diagnostycznym, wygasłym
adresem ani tą samą rodziną źródła. Błędy kolejki i transportu Native Messaging
nie są ponawiane, aby nie dodać materiału dwa razy.

Aby obejrzeć lub zapisać całą listę:

1. Otwórz stronę z materiałem i poczekaj kilka sekund. Skaner najpierw próbuje
   znaleźć źródła oraz wszystkie jawnie opisane jakości bez uruchamiania filmu.
   Jeżeli serwis tworzy podpisany URL dopiero po geście użytkownika, rozpoczęcie
   odtwarzania nadal może być konieczne — późniejszy ruch zostanie przechwycony
   automatycznie.
2. Otwórz popup rozszerzenia. Lista uzupełnia się w tle, a obserwacje techniczne
   są liczone osobno i ukryte przed odtwarzaniem. Dopisanie nowego potoku nie
   resetuje przewinięcia, otwartych szczegółów, fokusu ani chwilowo odsłoniętego
   adresu.
3. Podpisane adresy są odnawiane w tle przed upływem ważności. Jeśli właściwego
   materiału nadal brakuje, kliknij **Rozpoznaj stronę**.
4. Sprawdź etapy Streamlink/yt-dlp i wybierz pozycję albo
   **Otwórz polecany w MPV**.

Ręczny resolver korzysta z adresu faktycznie aktywnej karty, nigdy z URL-a
podanego przez stronę. Sam przycisk **Rozpoznaj stronę** w popupie tylko
uzupełnia listę; komenda PPM jest osobnym, jawnym poleceniem rozpoznania i
otwarcia. Skaner nie klika playera, nie przełącza kontrolek jakości i nie
wykonuje kodu witryny. Zamiast tego odczytuje warianty, które strona sama
ujawniła w danych, DOM-ie, zasobach albo manifeście. Adaptery TVP Sport i
YouTube dopasowują tryb platformy; wszystkie
pozostałe serwisy przechodzą przez adapter ogólny i zadziałają, jeśli ruch
strony, Streamlink lub yt-dlp rozpoznaje ich publiczny strumień.

Preferencje językowe Chrome są przekazywane jako ograniczona lista tagów języka.
Jeżeli manifest udostępnia polską ścieżkę, gotowy wpis zachowuje `pl-PL`, a MPV
dostaje bezpieczną preferencję `alang` również w trybach **Dodaj** i **Zastąp**.

Tryby odtwarzania:

- **Nowe** — uruchamia nowe MPV;
- **Dodaj** — dopisuje pozycję do playlisty działającego MPV;
- **Zastąp** — podmienia aktualną pozycję.

Auto-otwieranie jest domyślnie wyłączone i wymaga jawnej zgody osobno dla
każdej domeny. Dotyczy wyłącznie bezpiecznych kandydatów przechwyconych na
stronie; ręczne rozpoznawanie nie omija tej decyzji.

### Priorytety źródeł i widoczność adresów

Adapter ogólny działa na wszystkich stronach, więc nie trzeba dopisywać reguły
dla każdego serwisu. Na kłopotliwej domenie użytkownik może jednak nadać
rodzinie źródeł poziom **Preferuj**, **Normalnie** albo **Obniż**. Wzorzec
uwzględnia domenę CDN, typ i rolę strumienia, strukturę ścieżki, rozdzielczość,
bitrate oraz język, a zmienne identyfikatory materiału, daty i tokeny podpisu
zastępuje bezpiecznymi symbolami. Przykładowe
`.../{id}/720P_4000K_{id}.mp4/index.m3u8` pozostaje tą samą rodziną dla kolejnego
filmu, ale 1080p/8000K jest już innym wzorcem. Reguła obowiązuje wyłącznie na
dokładnej domenie oglądanej strony.

W panelu **Kolejność jakości dla tej witryny** można niezależnie ustawić kolejność
2160p, 1440p, 1080p, 720p i 480p. Domyślnie wygrywa 4K, następnie 1440p, Full HD,
720p i 480p; niższa lub nierozpoznana jakość pozostaje na końcu. Przy równej
jakości wygrywa wyższy bitrate. Priorytet użytkownika ani kolejność jakości nie
mogą przebić blokady reklamy, źródła diagnostycznego, ochrony przed możliwym
prerollem lub jawnie niekompletnego źródła tylko-wideo/tylko-audio.

Pełne adresy są domyślnie ukryte, ponieważ mogą zawierać tokeny dostępu. Przy
każdej pozycji można je odsłonić tylko na chwilę albo włączyć przełącznik
**Pełne URL dla tej witryny**, zapamiętywany osobno dla domeny. Lokalna reguła
priorytetu przechowuje odcisk wzorca, nie jego pełny podpisany URL. Mapa jest
ograniczona do 64 domen i 64 wyjątków na domenę; najstarsze wpisy są usuwane i
natychmiast czyszczone również z otwartych kart.

Na nieznanych platformach nowe źródło przechodzi krótki globalny okres ochronny.
Jeżeli aktywny odtwarzacz pokazuje krótki materiał początkowy, rozszerzenie czeka
na zmianę jego bieżącego źródła zamiast automatycznie wysłać możliwą reklamę do
MPV. Taki wpis nadal można świadomie otworzyć ręcznie z listy.

### Playlista M3U

**Pobierz adresy M3U** zapisuje aktualną, przefiltrowaną listę zwykłych adresów wraz z nazwą
metody wykrycia. Standardowy M3U nie przenosi niezawodnie nagłówków
Referer/Origin/User-Agent, dlatego takie źródła otwieraj przyciskiem MPV albo
zapisz skrypt z menu danej pozycji. Etykieta M3U pokazuje język, ale sam format
nie wymusza `alang`; przycisk MPV i zapisany skrypt zachowują tę preferencję.
Podpisane URL-e mogą szybko wygasać; wygasłe pozycje są ukrywane i odświeżane
w tle, ale zapisany wcześniej plik M3U nie może sam wymienić starego tokenu.
Polecany wpis YouTube jest dynamicznym
poleceniem yt-dlp, a nie bezpośrednim strumieniem, dlatego zapisuj go jako skrypt
MPV z menu wpisu zamiast umieszczać w M3U.

## Opcjonalna sesja strony (cookies)

Domyślnie Streamlink i yt-dlp nie otrzymują cookies. Dla strony HTTPS można
rozwinąć **Sesja strony (opcjonalnie)** i włączyć zgodę dla dokładnej bieżącej
domeny. Rozszerzenie wtedy:

- pobiera wyłącznie cookies pasujące do rzeczywistego URL-a aktywnej karty;
- przyjmuje maksymalnie 64 rekordy i 16 KiB danych;
- przekazuje je tylko podczas ręcznego rozpoznawania;
- zapisuje osobny tymczasowy plik `0600` dla jednej próby i zawsze go usuwa;
- nie umieszcza cookies w stanie popupu, odpowiedzi hosta ani logach.

Ważne: opcjonalne uprawnienie Chrome `cookies` jest technicznie globalne dla
zadeklarowanych stron HTTP/HTTPS. Ograniczenie do wskazanej domeny egzekwuje kod
rozszerzenia. Po wyłączeniu ostatniej domeny rozszerzenie usuwa to uprawnienie z
Chrome. Cookies nie są przekazywane po HTTP.

Jeśli serwis wymaga aktywnej sesji także podczas późniejszego pobierania
segmentów przez MPV, sam podpisany URL może nie wystarczyć.

## Bezpieczeństwo i ograniczenia

- Resolver dla aktywnego materiału YouTube uruchamia się raz na materiał po
  krótkim opóźnieniu, bez cookies i bez odtwarzania; ręczne ponowienie wymaga
  kliknięcia w popupie albo menu PPM. Proces zawsze działa w prywatnym pustym
  katalogu HOME/XDG, bez konfiguracji użytkownika, pluginów zewnętrznych,
  zdalnych komponentów i dodatkowego okna przeglądarki.
- Procesy mają limit czasu i rozmiaru odpowiedzi; timeout zatrzymuje całą grupę
  procesu. Globalna blokada nie pozwala kilku profilom uruchomić resolverów
  jednocześnie.
- Resolver odrzuca jawne adresy lokalne, loopback, link-local i prywatne. Obsługuje
  wyłącznie zwykłe strony HTTP/HTTPS.
- Automatyczny odczyt manifestów przyjmuje wyłącznie adres HTTPS; jawne adresy
  lokalne, loopback, link-local i prywatne są odrzucane. Odczyt nie wysyła
  cookies ani Referera i odrzuca przekierowania. Jeden odczyt ma limit
  6 sekund i 1 MiB, wynik najwyżej 24 najlepszych wariantów, a jedna nawigacja
  najwyżej 12 prób. Równolegle działa najwyżej 4 odczyty na kartę i 8 globalnie;
  oczekujące karty są obsługiwane kolejno po zwolnieniu miejsca.
- Adres potomny odczytany z HLS/DASH ponownie przechodzi tę samą kontrolę HTTPS
  i jawnych adresów lokalnych/prywatnych. Referer i Origin rodzica są
  dziedziczone tylko w obrębie dokładnie tego
  samego originu; wariant z innej domeny dostaje je dopiero po rzeczywistej
  obserwacji jego żądania przez Chrome.
- Rozszerzenie nie omija Widevine ani innych zabezpieczeń DRM.
- Serwis może zmienić API, wymagać niedostępnych kluczy lub blokować zewnętrzny
  odtwarzacz mimo poprawnego rozpoznania URL-a.

## Diagnostyka

Popup pokazuje osobno stan hosta, MPV i resolverów. Przy nieudanej analizie
wyświetla wynik każdej próby, np. **brak programu**, **wymaga aktualizacji**,
**bez wyniku**, **limit czasu** lub **niepoprawna odpowiedź**, bez stderr i
pełnych adresów.

Zredagowany log hosta znajduje się w:

```text
~/.local/state/mpv-redirector/host.log
```

Nie zawiera pełnych URL-i, tokenów, cookies, nagłówków ani stderr. Katalog ma
uprawnienia `0700`, a pliki `0600`.

## Testy w katalogu źródłowym

```bash
cd MPV-Redirector-Pro-3.4.9
node --check background.js
node --check content.js
node --check popup.js
node --test tests/background.test.js tests/background.integration.test.js tests/content.test.js tests/popup.test.js
python3 -m unittest discover -s tests -p 'test_*.py' -v
bash -n install.sh
./install.sh --check
```

Paczka wydaniowa nie zawiera katalogu `tests`. Lokalny fixture prawdziwego Chrome
w drzewie źródłowym nie używa prawdziwych tokenów ani materiałów.
