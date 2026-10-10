/**
 * Konstanten der Vorhersage „Demnächst sichtbar“ im Filter „Sichtbar“.
 *
 * DOM-frei, damit Worker, Node-Prüfskripte und Oberfläche dieselben Werte
 * importieren. Die Konstanten der Scan-Mathematik stehen in
 * src/math/forecast.ts, die der Nachführung in src/state/forecastView.ts.
 */

/** Wählbare Zeitfenster in Minuten – der Knopf im Listenkopf schaltet 5 → 10 → 20 → 5. */
export const FORECAST_WINDOWS_MIN = [5, 10, 20] as const;
export type ForecastWindowMin = (typeof FORECAST_WINDOWS_MIN)[number];
export const FORECAST_DEFAULT_WINDOW_MIN: ForecastWindowMin = 10;

/** Höchstzahl der Einträge in Liste, Himmel und Radar. */
export const FORECAST_MAX_SLOTS = 10;

/**
 * Gold wie HighlightMarkers. `--highlight` ist im Code die Farbe für
 * „sichtbar“; die Spuren übernehmen sie fest, auch im Nachtmodus (dort färbt
 * der CSS-Filter alles um).
 */
export const FORECAST_COLOR = '#ffd60a';

/**
 * Bis zu diesem Betrag des Zeitraffers läuft die Vorhersage mit, vorwärts wie
 * rückwärts. Darüber ruht sie: Bei ×600 vergehen 10 min in einer Sekunde, ein
 * Eintrag stünde nur Sekundenbruchteile (Nutzerentscheidung 08.10.2026).
 */
export const FORECAST_MAX_ABS_SCALE = 60;

/** Schlüssel in `localStorage`, Werte `'5' | '10' | '20'` – Muster wie das Theme. */
export const FORECAST_STORAGE_KEY = 'orbital-atlas:forecast-window';

/** Reichweite des Lang-Scans („Ausblick“) bei leerer Liste, in Minuten – auch Teil der Texte („bis 90 min“). */
export const FORECAST_FAR_HORIZON_MIN = 90;
