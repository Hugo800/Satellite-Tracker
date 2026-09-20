# Orbital Atlas

Mobile-first PWA – ein interaktiver 3D-Sternenatlas, der Satelliten in Echtzeit über dem
Standort des Nutzers trackt.

## Features

- **3D-Himmelskugel** – invertierte Sphäre (`BackSide`), Kamera exakt im Ursprung `(0, 0, 0)`.
- **Touch-Navigation** – OrbitControls zum Schwenken, Pinch/Wheel verändert die Brennweite (FOV).
- **AR-Modus** – `DeviceOrientationEvent` inkl. `requestPermission()`-Dialog für iOS Safari;
  Euler → Quaternion-Mapping direkt in `useFrame` (kein Gimbal Lock).
- **SGP4 im Web Worker** – `satellite.js` propagiert den gesamten Katalog mit 10 Hz;
  der Main-Thread erhält nur transferable `Float32Array`-Buffer.
- **GPU-Massendarstellung** – ein `THREE.InstancedMesh` für alle Katalogobjekte,
  eigene Meshes + Labels für ISS, Hubble und Tiangong.
- **Erdschatten-Logik** – Zylinderschattenmodell gegen den Sonnenvektor; verfinsterte
  Satelliten werden abgedunkelt.
- **Dynamischer Himmel** – Tag/Dämmerung/Nacht per Shader anhand des Sonnenstands
  (`astronomy-engine`), prozeduraler Sternenhimmel mit Spektralfarben und Szintillation.
- **Polar-Radar** – Zenit im Mittelpunkt, Horizont am Rand, inkl. Kamera-FOV-Kegel.
- **Telemetrie-HUD** – Elevation, Azimut, Distanz, Bahnhöhe, Geschwindigkeit, Subpunkt
  sowie AOS/TCA/LOS-Vorhersage für die nächsten 48 h.
- **Astronomischer Nachtmodus** – Monochrom-Rotlicht über UI *und* WebGL-Canvas.

## Architektur-Prinzip

Winkel, Positionen und Quaternionen liegen **nie** im React-State. Sie werden in
`src/state/runtime.ts` als Modulzustand gehalten und ausschließlich in `useFrame`
bzw. in eigenen rAF-Schleifen der 2D-Overlays gelesen/mutiert. React-State ist
Konfiguration (Katalog, Filter, Auswahl, Sonnenstand) vorbehalten.

```
src/
  components/canvas/   R3F-Szene (Dome, Sterne, Gitter, Satelliten, Trail, Kamera, Picking)
  components/ui/       HUD, Radar, Telemetrie, Drawer
  hooks/               Geolocation, DeviceOrientation, Worker-Bridge, Sonnenstand
  math/                Koordinaten, Sonnenvektor, SGP4-Wrapper, Pass-Vorhersage
  state/               Zustand-Store (React) + Laufzeit-Refs (Nicht-React)
  workers/             SGP4-Worker
```

## Entwicklung

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc -b && vite build
npm run preview
```

> Geolocation und Bewegungssensoren benötigen einen sicheren Kontext.
> `localhost` gilt als sicher; im LAN (`--host`) ist HTTPS erforderlich.

## Deployment auf GitHub Pages

`vite.config.ts` nutzt `base: './'`, die Anwendung läuft damit unter jedem
Unterpfad ohne Rebuild.

1. Repository → **Settings → Pages → Source: GitHub Actions**
2. Push auf `main` – `.github/workflows/deploy.yml` baut und veröffentlicht automatisch.

## Datenquelle

TLE-Kataloge von [CelesTrak](https://celestrak.org) (`stations`, `visual`, `weather`,
`starlink`). CelesTrak beantwortet Wiederholungsabrufe innerhalb des zweistündigen
Update-Intervalls mit HTTP 403 – der Worker greift dann auf seine eigene
CacheStorage-Kopie zurück; offline existiert zusätzlich ein Minimal-Fallback.
