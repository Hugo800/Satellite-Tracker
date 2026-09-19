# 🛰 SatTracker – Interaktiver Sternenatlas

Eine vollständige, mobile-first **Progressive Web App** (PWA) als Single-Page-Anwendung, die wie ein interaktiver Sternenatlas funktioniert und Satelliten in Echtzeit über dem aktuellen Standort trackt.

[![GitHub Pages ready](https://img.shields.io/badge/GitHub%20Pages-Ready-brightgreen)](#deployment)
[![PWA](https://img.shields.io/badge/PWA-Installierbar-blue)](#pwa)
[![No API Key](https://img.shields.io/badge/API--Key-Keiner%20nötig-success)](#data-sources)

---

## ✨ Features

### 🌌 Interaktiver Himmelsdom
- **360°-Gnomonic-Projektion** des Himmels auf dem Display
- **Himmelsrichtungen** (N/O/S/W) und Höhenkreise (0°/30°/60°/90° Zenith)
- **Dynamischer Sternenhintergrund** mit ~400 Sternen
- **Orbitspuren** (40-Punkte-Verlaufsspur) für sichtbare Satelliten
- **Echtzeit-Telemetrie** direkt im Dome: Azimut, Elevation, Name

### 🛰 Satelliten-Tracking
- **10 Satellitengruppen** via Celestrak: ISS, Tiangong, Hubble, NOAA, Starlink, Terra, Aqua u.a.
- **SGP4-Bahnberechnung** via `satellite.js` vollständig im Browser
- **Echtzeit-Update** jede Sekunde (requestAnimationFrame-Loop)
- **10 Fallback-TLEs** garantieren Funktion ohne Internet

### 📱 Steuerung
| Eingabe | Aktion |
|---------|--------|
| Drag (1 Finger / Maus) | Himmelsdom drehen |
| Pinch / Mausrad | Zoom (FoV 15°–150°) |
| Tap auf Satellit | Telemetrie öffnen |
| Gyroskop (optional) | Automatische AR-Ansicht |

### 🔭 Gyroskop / AR-Modus
- **DeviceOrientationEvent** mit iOS 13+ Permission-Flow
- Hält sich das Smartphone Richtung Himmel, dreht sich der Dome automatisch mit
- Kompass-Heading (Alpha) + Tilt (Beta) → Azimut + Elevation

### 🌙 Nachtsicht-Modus
- Rotes Farbschema zum Erhalt der Dunkeladaption beim Sternbeobachten
- Ein Knopfdruck wechselt alle Elemente (Canvas, HUD, Panels)

### 📡 Radar Mini-Map
- Polarer Übersichts-Plot (North-up, Elevation-Ringe)
- Alle Satelliten über dem Horizont auf einen Blick
- Farbcodierung: ISS=Cyan, Starlink=Lila, NOAA=Amber

### 📋 Telemetrie-Panel
- Azimut, Elevation, Entfernung (km), Bahnhöhe (km), Geschwindigkeit (km/h)
- Sichtbarkeitsstatus (🟢 Sichtbar / 🟡 Horizont / 🔴 Unter Horizont)
- **Pass-Vorschau**: nächster Auf- und Untergang + maximale Elevation

---

## 🏗 Architektur

```
sattracker/
├── index.html        # HTML-Shell, Canvas-Elemente, Overlay-Panels
├── style.css         # Sci-Fi Dark Theme, CSS Custom Properties, Night-Mode
├── app.js            # Gesamte App-Logik (modulare Sections)
│   ├── CONFIG        # Tuneable Konstanten
│   ├── State         # Shared mutable state
│   ├── Utils         # Gnomonic-Projektion, Mathe-Helfer
│   ├── GeoModule     # navigator.geolocation watchPosition
│   ├── TLEModule     # Fetch + sessionStorage-Cache + Fallback
│   ├── OrientationModule # DeviceOrientationEvent + iOS-Permission
│   ├── TouchModule   # Pointer Events (Drag, Pinch, Click)
│   ├── PropagationModule # satellite.js SGP4 + Pass-Berechnung
│   ├── StarField     # Statisches Sternenfeld (400 Sterne)
│   ├── SkyRenderer   # Canvas 2D Himmelsdom-Renderer
│   ├── RadarRenderer # Polarer Mini-Plot Canvas
│   ├── UIModule      # Panels, Liste, Telemetrie, Toasts
│   └── App           # Bootstrap + rAF-Loop
├── manifest.json     # PWA Manifest
├── sw.js             # Service Worker (Cache-First + Network-First)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

---

## 🚀 Deployment

### GitHub Pages (empfohlen)
```bash
git add .
git commit -m "feat: initial SatTracker PWA"
git push origin main
# → Settings → Pages → main branch / root
```

### Lokal (Development)
```bash
# Option 1: npx
npx serve .

# Option 2: Python
python3 -m http.server 8080

# Option 3: VS Code Live Server
```
> ⚠️ **HTTPS erforderlich** für Geolocation und DeviceOrientation API. Lokal funktioniert `localhost`, für Mobilgeräte im Netz → GitHub Pages oder ngrok.

---

## 📡 Datenquellen

| Gruppe | Quelle | CORS |
|--------|--------|------|
| Raumstationen (ISS, Tiangong) | Celestrak | ✅ |
| Hubble | Celestrak (CATNR 20580) | ✅ |
| NOAA-Satelliten | Celestrak | ✅ |
| Starlink | Celestrak | ✅ |
| Wettersatelliten | Celestrak | ✅ |

TLE-Daten werden im `sessionStorage` für 4 Stunden gecacht. Offline-Betrieb wird durch 10 hardcodierte Fallback-TLEs garantiert.

---

## 🛠 Technologien

- **HTML5 / CSS3 / Vanilla JavaScript** – keine Frameworks
- **[satellite.js 4.1.3](https://github.com/shashwatak/satellite-js)** – SGP4-Bahnberechnung
- **Canvas 2D API** – Rendering (kein WebGL benötigt)
- **Pointer Events API** – Unified Touch + Mouse
- **DeviceOrientation API** – Gyroskop / Kompass
- **Service Worker + Cache API** – PWA / Offline
- **navigator.geolocation** – GPS-Standort

---

## 📜 Lizenz

MIT © 2026

