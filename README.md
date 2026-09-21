# Orbital Atlas

Mobile-first PWA – ein interaktiver 3D-Sternenatlas, der Satelliten in Echtzeit über dem
Standort des Nutzers trackt.

## Features

- **Vollständiger Katalog, ohne Obergrenze** – im Modus „Alle“ wird ausnahmslos jedes
  trackbare Objekt über dem Horizont propagiert und dargestellt. Es gibt an keiner Stelle
  der Kette ein `slice()`, ein `limit` oder ein `MAX_…`, das Objekte verschluckt.
- **3D-Himmelskugel** – invertierte Sphäre (`BackSide`), Kamera exakt im Ursprung `(0, 0, 0)`.
- **Touch-Navigation** – OrbitControls zum Schwenken, Pinch/Wheel verändert die Brennweite (FOV).
- **AR-Modus** – `DeviceOrientationEvent` inkl. `requestPermission()`-Dialog für iOS Safari;
  Euler → Quaternion-Mapping direkt in `useFrame` (kein Gimbal Lock).
- **SGP4-Worker-Pool** – der Katalog wird per Modulo auf mehrere Worker verteilt und mit
  10 Hz propagiert; der Main-Thread erhält nur transferable `Float32Array`-Buffer und
  gibt sie zum Wiederverwenden zurück.
- **GPU-Massendarstellung** – eine `InstancedBufferGeometry` mit eigenem Shader für den
  gesamten Katalog; eigene Meshes + Labels für ISS, Hubble und Tiangong.
- **Erdschatten-Logik** – Zylinderschattenmodell gegen den Sonnenvektor; verfinsterte
  Satelliten werden abgedunkelt.
- **Dynamischer Himmel** – Tag/Dämmerung/Nacht per Shader anhand des Sonnenstands
  (`astronomy-engine`), prozeduraler Sternenhimmel mit Spektralfarben und Szintillation.
- **Polar-Radar** – Zenit im Mittelpunkt, Horizont am Rand, inkl. Kamera-FOV-Kegel.
- **Telemetrie-Karte** – Elevation, Azimut, Distanz, Bahnhöhe, Geschwindigkeit, Subpunkt
  sowie AOS/TCA/LOS-Vorhersage für die nächsten 48 h.
- **Hell/Dunkel im Apple-Stil** – Systemschrift, Materialien mit `backdrop-filter`,
  Haarlinien, iOS-Systemfarben, gleitender Segment-Umschalter; Dark-Mode OLED-freundlich
  auf echtem Schwarz. Folgt dem System oder wird manuell gesetzt.
- **Astronomischer Nachtmodus** – Monochrom-Rotlicht über UI *und* WebGL-Canvas.

## Architektur-Prinzipien

### 1. Winkel gehören nicht in den React-State

Positionen, Winkel und Quaternionen liegen **nie** im React-State. Sie werden in
`src/state/runtime.ts` als Modulzustand gehalten und ausschließlich in `useFrame`
bzw. in eigenen rAF-Schleifen der 2D-Overlays gelesen/mutiert. React-State ist
Konfiguration (Katalog, Filter, Auswahl, Sonnenstand, Theme) vorbehalten.

### 2. Telemetrie-Indizes sind für immer stabil

Jede NORAD-ID bekommt beim ersten Auftreten einen globalen Index, der sich nie wieder
ändert. Der Katalog wächst dadurch rein additiv: Erst laden die kleinen, spezifischen
Gruppen (Stationen, hellste Objekte, Wetter, Starlink) und liefern Farbe und Filter,
danach füllt `GROUP=active` den Rest des Katalogs auf. Eine laufende Auswahl, eine
gezeichnete Bahnspur und eine offene Überflugliste überstehen das Nachladen unverändert.

Der eingebaute Offline-Katalog wird dabei nicht verworfen, sondern **an Ort und Stelle**
durch echte Daten ersetzt, sobald sie eintreffen.

### 3. Der Katalog wird über Worker verteilt

Worker `s` von `n` ist für alle Indizes mit `index % n === s` zuständig. Die Zuteilung
ist rein rechnerisch – niemand muss beim Wachsen des Katalogs neu verteilen. Shard 0
ist zugleich der Lader: Nur er ruft CelesTrak ab (sonst liefen `n` parallele Abrufe
derselben URL ins Rate-Limit) und reicht den Rohtext über den Main-Thread weiter, damit
alle Shards die Gruppen in derselben Reihenfolge sehen.

Die virtuelle Zeit ist eine **reine Funktion** der Wanduhr
(`virtual(now) = origin + (now - realOrigin) × scale`). Dadurch rechnen alle Shards
garantiert dieselbe Epoche, ohne dass sie sich untereinander synchronisieren müssten.

Die Revision der Telemetrie springt erst weiter, wenn *alle* Shards geliefert haben –
sonst würde die Szene zwischen zwei halb aktuellen Ständen interpolieren.

### 4. Pro Frame wird nichts mehr gerechnet, was pro Tick reicht

Der Vertex-Shader bekommt je Instanz nur Vorgänger- und Zielwinkel, Farbe und Größe,
und zwar im Takt der Telemetrie (10 Hz). Interpolation, Kugelprojektion und
Billboarding passieren auf der GPU; pro Frame wird lediglich ein einzelnes
`uT`-Uniform gesetzt. Gegenüber dem früheren Weg – eine 4×4-Instanzmatrix je Objekt und
Frame – spart das bei 12 000 Objekten rund 46 MB/s an Upload-Bandbreite.

```
src/
  components/canvas/   R3F-Szene (Dome, Sterne, Gitter, Satelliten, Trail, Kamera, Picking)
  components/ui/       Kopfzeile, Radar, Telemetrie, Liste
  data/                TLE-Quellen, Gruppenfarben, Filtermodi
  hooks/               Geolocation, DeviceOrientation, Worker-Pool, Sonnenstand, Theme
  math/                Koordinaten, Sonnenvektor, SGP4-Wrapper, Pass-Vorhersage
  state/               Zustand-Store (React) + Laufzeit-Refs (Nicht-React)
  workers/             SGP4-Worker (ein Shard je Instanz)
  scripts/             Verifikation und Benchmark des Rechenkerns
```

## Entwicklung

```bash
npm install
npm run dev              # http://localhost:5173
npm run build            # tsc -b && vite build
npm run lint
npm run test             # typecheck + lint + Verifikation des Rechenkerns
```

> Geolocation und Bewegungssensoren benötigen einen sicheren Kontext.
> `localhost` gilt als sicher; im LAN (`--host`) ist HTTPS erforderlich.

### Rechenkern prüfen und messen

```bash
npm run verify:fastpath     # propagateInto() gegen satellite.js
npm run bench:propagation   # ms je Propagationsschritt, Empfehlung zur Poolgröße
```

`propagateInto()` zieht `gstime()`/`jday()` aus der Schleife und rechnet ECI→ECF,
Blickwinkel und Subpunkt selbst, um pro Satellit und Tick vier Zwischenobjekte zu
sparen. `verify:fastpath` rechnet das über mehrere Bahnfamilien, Standorte und
Zeitpunkte gegen satellite.js gegen – bei einer Abweichung schlägt es fehl.

## Deployment auf GitHub Pages

`vite.config.ts` nutzt `base: './'`, die Anwendung läuft damit unter jedem
Unterpfad ohne Rebuild.

1. Repository → **Settings → Pages → Source: GitHub Actions**
2. Push auf `main` – `.github/workflows/deploy.yml` baut und veröffentlicht automatisch.

## Datenquelle

TLE-Kataloge von [CelesTrak](https://celestrak.org): `stations`, `visual`, `weather`,
`starlink` und `active` (der vollständige Satz aktiver Objekte, rund 12 000 Sätze).
CelesTrak beantwortet Wiederholungsabrufe innerhalb des zweistündigen Update-Intervalls
mit HTTP 403 – der Lader-Shard greift dann auf seine eigene CacheStorage-Kopie zurück;
offline existiert zusätzlich ein Minimal-Fallback.
