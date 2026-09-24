import { Euler, Quaternion, Vector3 } from 'three';
import { DEG, angleDelta, clamp } from './coords';

/**
 * Tiefster Blickwinkel im AR-Modus. Die Ansicht ist auf die obere Halbkugel
 * beschränkt: Zeigt das Gerät unter den Horizont, rastet das Bild dort ein,
 * statt in die Bodenebene weiterzudrehen.
 */
export const AR_MIN_ELEVATION = 0;

/** iOS meldet die Kompassgüte in Grad; darüber gilt er als unkalibriert. */
export const MAX_COMPASS_ACCURACY_DEG = 25;

const ZEE = new Vector3(0, 0, 1);
const ZENITH = new Vector3(0, 1, 0);
const EULER = new Euler();
const Q0 = new Quaternion();
/** −90° um X: Gerätesystem (Bildschirm-normal = +Z) -> Kamerasystem (Blick = −Z). */
const Q1 = new Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

/**
 * Wandelt die Euler-Winkel des `deviceorientation`-Events in die Gerätelage.
 *
 * Bewusst über Quaternionen statt Euler-Zuweisung: Bei senkrecht gehaltenem
 * Gerät (beta ≈ 90°) läuft eine naive Euler-Kette in den Gimbal Lock.
 *
 * Resultierendes Weltsystem: +Y = Zenit, −Z = Nord, +X = Ost. Eine Drehung um
 * +Y entspricht damit genau einer Änderung von alpha.
 */
export function eulerToAttitude(
  target: Quaternion,
  alphaRad: number,
  betaRad: number,
  gammaRad: number,
): Quaternion {
  EULER.set(betaRad, alphaRad, -gammaRad, 'YXZ');
  return target.setFromEuler(EULER);
}

/** Setzt Kameraachsen und Bildschirmdrehung auf eine Gerätelage – ergibt das Kamera-Quaternion. */
export function attitudeToCamera(
  target: Quaternion,
  attitude: Quaternion,
  screenAngleRad: number,
): Quaternion {
  target.copy(attitude).multiply(Q1);
  return target.multiply(Q0.setFromAxisAngle(ZEE, -screenAngleRad));
}

/**
 * Zeitkonstante, mit der die Kurskorrektur ψ dem Kompass folgt.
 *
 * ψ ist nur der Versatz zwischen Kreisel und Nordrichtung; Drehungen erreichen
 * die Anzeige über den Kreisel ohne Verzögerung. ψ muss deshalb nicht schnell
 * sein, sondern ruhig. Bei 60 Hz ergibt τ = 1 s den Schrittanteil
 * k = 1 − e^(−1/60) = 0,0165:
 * - ein einzelner Ausreißer um 20° verschiebt ψ um 0,33°,
 * - weißes Kompassrauschen fällt auf √(k/(2−k)) = 9 % seiner Streuung (±4° → ±0,37°),
 * - eine echte Kompasskorrektur ist nach 3 s zu 95 % übernommen.
 */
const OFFSET_TIME_CONSTANT_S = 1;

/**
 * Ab dieser Abweichung von ψ gilt eine Kompassmessung als Ausreißer. Das
 * Doppelte der Kalibriergrenze: Eine Korrektur um die volle Unsicherheit, die
 * iOS noch als kalibriert meldet, wird weich übernommen; ein 180°-Sprung oder
 * ein neu gesetzter Kreiselnullpunkt nicht.
 *
 * Zugleich die Obergrenze jeder Nachführung: ψ bewegt sich pro Sample höchstens
 * um k · 50° = 0,83°, also mit höchstens 49,6°/s bei 60 Hz. Auch der erste
 * Nordbezug bei schon laufender Anzeige und die Korrektur eines vorläufigen
 * Nordbezugs laufen deshalb als Schwenk, nie als Sprung.
 */
const OUTLIER_GATE_RAD = 2 * MAX_COMPASS_ACCURACY_DEG * DEG;

/**
 * So lange müssen kalibrierte Ausreißer untereinander übereinstimmen, bis ψ
 * ihnen folgt – und dann nur mit `OUTLIER_FOLLOW_RATE`, nie als Sprung.
 *
 * Die bisherigen 1 s mit anschließendem Neu-Setzen machten aus jeder Störung
 * über 1 s zwei Sprünge (gemessen: 1,5 s gestörter Kompass ergab +98,6° und
 * −98,0° je in einem Sample). Eine Störung (Metall, Geländer, Fahrzeug) und
 * eine abgeschlossene Kalibrierung sehen für den Filter gleich aus;
 * unterscheiden lassen sie sich nur an der Dauer. Die Kosten sind ungleich: Zu
 * frühes Folgen erzeugt einen neuen Fehler, zu spätes verlängert nur einen
 * bestehenden. Daher 3 s, gezählt nur über verwertbare Samples (ruhige Lage,
 * gültige Genauigkeit); unkalibrierte zählen anteilig
 * (`OUTLIER_CONFIRM_UNCALIBRATED_S`).
 */
const OUTLIER_CONFIRM_S = 3;

/**
 * Bestätigungszeit für Ausreißer, die iOS nicht als kalibriert meldet
 * (Genauigkeit über 25°). Sie zählen mit dem Anteil 3/10 an der Bestätigung,
 * gemischt entsprechend dazwischen.
 *
 * Nie bestätigen hieße: Lag der erste Nordbezug mehr als 50° daneben und meldet
 * iOS danach dauerhaft nur 26° bis 40°, blieb der Fehler für immer stehen
 * (Prüfer: 100,1° nach 1, 10, 30 und 60 s). Eine Störung durch Metall kommt
 * aber oft gerade mit schlechter Genauigkeit; darum deutlich länger als die 3 s
 * für kalibrierte Werte. Danach folgt ψ mit `OUTLIER_FOLLOW_RATE` mal Gewicht:
 * bei 30° Genauigkeit (25/30)² · 15°/s = 10,4°/s, bei 40° 5,9°/s.
 * Gemessen (Prüfung 9f, erster Wert 100° daneben, danach richtig): unter 2°
 * nach 17,6 s bei 26° Genauigkeit, 20,0 s bei 30°, 31,6 s bei 40° (Auslegung
 * bei 40°: 0,5 + 10 + 8,5 s Folgen + 8,2 s Einschwingen ≈ 27 s; die übrigen
 * 4,6 s nicht aufgeschlüsselt). Eine Störung von 8 s mit 40° Genauigkeit
 * bleibt folgenlos (Prüfung 9e: 0,57°; kalibriert wären es 90,7°).
 */
const OUTLIER_CONFIRM_UNCALIBRATED_S = 10;

/**
 * Tempo, mit dem ψ einem bestätigten Ausreißer folgt. Langsamer als die
 * Nachführung an der Torgrenze (49,6°/s), weil ein bestätigter Ausreißer immer
 * noch eine lange Störung sein kann. Ausgelegt (Prüfung 9, Kompass 100°
 * daneben): Eine Störung von 5 s verschiebt die Anzeige um (5 − 3) s · 15°/s =
 * 30° (gemessen 30,6°) – das bleibt im Tor, nach dem Ende kehrt ψ ohne neue
 * Bestätigungszeit zurück (unter 1° nach 3,2 s). Mit 49,6°/s waren es 80° und
 * 7,5 s bis zur Rückkehr. Eine echte Korrektur um 90° ist nach
 * 3 s + 40°/(15°/s) + 3 τ ≈ 9 s übernommen (gemessen 8,9 s); je Sample bewegt
 * sich die Anzeige dabei um 0,25°.
 *
 * Bewusste Abwägung, nachgemessen (Prüfer-Szenarien S4/S5): Eine kalibrierte
 * Störung von 10 s zieht die Anzeige bis 98,6° weg, zurück unter 2° erst 9,4 s
 * nach ihrem Ende (wieder 3 s Bestätigung + 3,2 s Folgen + 3,2 s Einschwingen).
 * Ist schon der erste Wert beim Start 2 s lang 170° gestört, liegt die Anzeige
 * erst nach 16,2 s unter 2°. Schneller ginge es nur, wenn ψ großen Abweichungen
 * früher oder schneller folgt – das ist die Doppelsprung-Falle von vorher:
 * Jede Störung über der kürzeren Frist wird erst übernommen und dann wieder
 * zurückgenommen (mit 49,6°/s: 80° Ausschlag bei 5 s Störung). Eine Rückkehr
 * ohne neue Bestätigung zu einem gemerkten früheren Stand würde nur den ersten
 * Fall um die 3 s kürzen und bräuchte eine Regel, wann dieser Stand verfällt;
 * sie ist nicht umgesetzt.
 */
const OUTLIER_FOLLOW_RATE = 15 * DEG;

/**
 * Oberhalb dieser Drehrate wird ψ nicht nachgeführt. Der Kompass hinkt der
 * Lage hinterher (Latenz von CLHeading ist nicht dokumentiert und hier nicht
 * gemessen); jeder Vergleich während einer Drehung misst Drehrate × Latenz mit.
 * Bei 10°/s und angenommenen 300 ms Latenz sind das höchstens 3°, die ψ nur mit
 * τ = 1 s erreicht (Prüfung 2: 8°/s bei 300 ms ergibt 2,38°). Mit der vorigen
 * Grenze 30°/s lief ψ einem Schwenk von 25°/s bei 150 ms Latenz hinterher und
 * ließ 3,68° Fehler stehen, mit 10°/s 0,00°. Die Drehung trägt der Kreisel.
 */
const MAX_REFERENCE_RATE = 10 * DEG;

/**
 * Nach einer schnellen Drehung bleibt die Nachführung so lange aus, bis auch ein
 * träger Kompass aufgeholt hat. 500 ms decken 300 ms Latenz mit Reserve ab
 * (längere Latenz ist nicht abgedeckt). 90°/s-Drehung bei 300 ms Latenz: vorige
 * Fassung ohne Pause 3,12° Fehler nach dem Stopp, jetzt 0,28° (Prüfung 2).
 */
const REFERENCE_HOLD_MS = 500;

/**
 * Längste Lücke zwischen zwei Sensor-Events, die noch als laufender Strom gilt.
 * Android liefert teils nur 15 Hz (67 ms); 500 ms sind mehr als sieben
 * ausgefallene Samples – kein Jitter mehr, sondern App-Wechsel, Sperre oder ein
 * versiegter Strom. Danach kann iOS den Kreiselnullpunkt neu gesetzt haben
 * (WebKit startet CMMotionManager neu, sobald wieder ein Listener hängt), der
 * Nordbezug wird deshalb neu bestimmt. Die Anzeige läuft dabei sofort weiter,
 * siehe `REFERENCE_WAIT_MS`.
 */
const SENSOR_TIMEOUT_MS = 500;

/**
 * Frist für den ersten Nordbezug nach einem Start oder einer Lücke. Innerhalb
 * der Frist wird er gesetzt, danach nur noch begrenzt herangeführt.
 *
 * Beim ersten Start zeigt die Kamera währenddessen die Touch-Ansicht, die Anzeige
 * wartet also still auf den Nordbezug (erster Kompasswert verwertbar: gültige
 * Genauigkeit, eindeutige Lage, ruhiges Gerät) und läuft erst nach Ablauf ohne
 * ihn an. Nach einer Lücke stünde dagegen das letzte AR-Bild eingefroren da;
 * dort läuft die Anzeige sofort mit dem bisherigen Versatz weiter (siehe
 * `HeadingFusion`), und ein Nordbezug innerhalb der Frist ersetzt ihn direkt.
 * 1 s lässt Zeit für das Anheben des Geräts und für die ersten echten
 * CLHeading-Werte nach den WebKit-Platzhaltern (Prüfung 3b: 100 bis 500 ms)
 * und bleibt unter der 2,5-s-Warnung „Keine Sensordaten“ in useDeviceOrientation.
 */
const REFERENCE_WAIT_MS = 1000;

/**
 * Nach einer Lücke weiß die Fusion nicht, ob der Kreiselnullpunkt neu gesetzt
 * wurde (App-Wechsel) oder nicht (blockierter Hauptthread). Ist die Lage
 * mehrdeutig, liefert der Kompass nur die Mitte m beider Deutungen und ihre
 * halbe Spreizung h (siehe `MAX_HEADING_SPREAD_RAD`; m bis zum Fristende
 * geglättet, siehe `RESUME_SMOOTHING_S`). Der bisherige Versatz
 * gilt als widerlegt, wenn er weiter als h plus diese Toleranz von m entfernt
 * liegt – dann läuft die Anzeige mit m weiter (höchstens h daneben). Sonst
 * bleibt er als vorläufiger Nordbezug stehen.
 *
 * 25° ist die Unsicherheit, die iOS noch als kalibriert meldet; schlechtere
 * gemeldete Genauigkeit vergrößert die Toleranz entsprechend. Preis: Ist der
 * Nullpunkt doch neu gesetzt, besteht ein zufälliger alter Versatz die Prüfung
 * mit der Wahrscheinlichkeit (2h + 50°)/360°, bei h = 26,6° (3° Höhe, 4° Roll)
 * also 29 %; der Fehler ist dann höchstens 2h + 25° = 78°. Mit der Mitte als
 * Startwert wären es immer bis zu h = 26,6°, auch wenn der Nullpunkt gar nicht
 * neu gesetzt wurde – vorher 0,56° (Prüfer-Szenario S2b). Bestätigt ist der
 * alte Versatz damit nicht: Die Anzeige gilt als relativ, bis ein Nordbezug
 * aus eindeutiger Lage kommt.
 */
const RESUME_TOLERANCE_DEG = MAX_COMPASS_ACCURACY_DEG;

/**
 * Zeitkonstante, mit der die Kompass-Mitte m nach einer Lücke geglättet wird,
 * bevor sie über den fortgesetzten Versatz entscheidet (`checkResume`).
 *
 * Warum mehr als ein Sample: Nach einem App-Wechsel liefert WebKit zunächst
 * noch den alten Kurs (Prüfer-Szenario S6: 0,3 s). Wurde nur einmal mit dem
 * ersten Sample geprüft und hatte sich das Gerät in der Pause um Δ gedreht,
 * blieb diese veraltete Mitte stehen, solange die Lage mehrdeutig war – Fehler
 * h + Δ. Gemessen (Prüfung 3j: 3° hoch, 4° Roll, 36 neue Nullpunkte, Median):
 * 66,6° bei Δ = 40°, 116,6° bei 90°, 153,4° bei 180° statt 26,6°. Deshalb
 * wird bis zum Fristende mit jedem Sample neu entschieden, immer gegen den
 * Versatz von vor der Lücke.
 *
 * Warum geglättet statt mit dem jüngsten Einzelwert: Dann erreicht jede Messung
 * die Anzeige ungedämpft. Gemessen (Prüfung 3j, σ 1° Kursrauschen): 4,81°
 * größte Änderung je Sample in der Frist, und liegt der alte Versatz nahe an
 * der Toleranzgrenze, kippt die Entscheidung mit dem Rauschen hin und her
 * (52,5° bzw. 70,3° je Sample, Deutung −alpha). Prüfung 3h stieg auf 28,91°
 * über ihre Grenze 28,1°. Die Entscheidung erst am Fristende hilft nicht: Bis
 * dahin stünde nach neu gesetztem Nullpunkt der alte Versatz daneben (Prüfung
 * 3h: 161,97°). Sofort und am Fristende noch einmal mit dem Einzelwert zu
 * entscheiden lässt die veraltete Mitte die ganze Frist stehen (erst nach
 * 1,00 s auf 2° am Endwert statt nach 0,58 bis 0,73 s, Median über Δ = 40° bis
 * 180°) und behält 1,83° bzw. 2,30° Änderung je Sample.
 *
 * τ = 0,1 s, bei 60 Hz also k = 1 − e^(−1/6) = 0,154 je Sample:
 * - Das Rauschen fällt auf √(k/(2 − k)) = 29 % (σ 1° → 0,29°); gemessen 0,51°
 *   größte Änderung je Sample in der Frist statt 4,81° – allerdings nur über
 *   die 36 Nullpunkte der Prüfung 3j, die in 10°-Schritten liegen und die
 *   Toleranzgrenze nicht treffen. Das Kippen ist damit stark gedämpft, aber
 *   nicht beseitigt: Über 360 Nullpunkte in 1°-Schritten kippen 4 Rückkehr-
 *   fälle weiterhin um ±51,6° (Einzelwert-Variante 11 Fälle, Stand Runde 4
 *   keiner – dort blieb dafür die veraltete Mitte stehen). Die Kamera pendelt
 *   dabei bis 7,7° je Bild. Eine Hysterese auf der Toleranzgrenze wäre die
 *   Behebung; sie ist bewusst nicht eingebaut, weil sie denselben
 *   Rückkehr-Pfad berührt, der in dieser Runde schon zweimal umgebaut wurde.
 * - Veraltete Werte der ersten 0,3 s wiegen am Fristende noch e^(−0,7/0,1) =
 *   0,09 % (0,16° bei Δ = 180°); dauert der alte Kurs 0,5 s, e^(−5) = 0,7 %
 *   (1,2°). Gemessen (Prüfung 3j): Median 26,5° bis 26,6° für Δ = 0° bis 180°,
 *   Querformat 44,9° bis 45,1° – die halbe Spreizung h, unabhängig von Δ.
 * - τ = 0,2 s glättet kaum besser (0,25° je Sample), lässt aber e^(−3,5) = 3 %
 *   der veralteten Werte bis zum Fristende stehen (gemessen Median 31,4° bei
 *   Δ = 180°). τ = 0,05 s: 1,00° je Sample.
 * Danach glättet ohnehin noch die Kamera (τ = 103 ms, CameraRig).
 */
const RESUME_SMOOTHING_S = 0.1;

/**
 * So lange gilt nach einer Lücke der Status von vor der Lücke weiter, solange
 * weder ein Nordbezug kam noch der Kompass widersprach. Sonst blinkte die
 * Warnung „Kein erdfester Kompass“ bei jeder Rückkehr für ein Bild auf: Android
 * liefert das erste erdfeste Event 8 bis 17 ms nach dem relativen, bei 15 Hz bis
 * 67 ms. Länger als 100 ms behauptet die Fusion keinen unbestätigten Nordbezug;
 * iOS mit Platzhalterkurs nach der Rückkehr zeigt danach „relativ“, bis der
 * erste echte Kurs kommt.
 */
const RESUME_STATUS_HOLD_MS = 100;

/** Längster Abstand, mit dem ein Referenzsample in ψ eingeht: langsamste übliche Rate (15 Hz). */
const MAX_REFERENCE_INTERVAL_S = 1 / 15;

/**
 * Unter diesem |cos β| steht die Geräteoberkante fast senkrecht (Hochformat,
 * Blick bis ±14,5° um den Horizont). Dort drehen alpha und gamma nahezu um
 * dieselbe Achse; die Euler-Zerlegung verteilt die Drehung beliebig auf beide.
 * Jede Uneinigkeit zwischen Kompass und Kreisel (Zeitversatz, andere Fusion)
 * geht mit 1/|cos β| – hier mehr als vierfach – in den alpha-Vergleich ein.
 */
const MIN_ALPHA_CONDITION = 0.25;

/**
 * Über diesem |cos β · cos γ| zeigt die Kamera fast senkrecht (ab 75,9° Höhe
 * oder Tiefe, Grenze aus der bisherigen Fassung). Dort hat die Blickrichtung
 * kaum noch einen waagrechten Anteil, jeder Kurs ist schlecht bestimmt.
 */
const NEAR_VERTICAL = 0.97;

/**
 * Offene Frage, NICHT belegt: Welche Geräterichtung meint `webkitCompassHeading`?
 *
 * Belegt ist nur die Übergabe: WebKit reicht `CLHeading.magneticHeading`
 * unverändert durch (Source/WebCore/platform/ios/WebCoreMotionManager.mm,
 * Z. 318, Stand WebKit-Commit 75bb189, 08.08.2026) und setzt
 * `CLLocationManager.headingOrientation` nirgends (Codesuche im Repository
 * WebKit/WebKit: kein Treffer außerhalb einer SDK-Datenbank), es gilt also die
 * Vorgabe Hochformat. Apple beschreibt den Kurs nur als Richtung der
 * „top of the device in portrait mode“ (Doku zu `headingOrientation`) und sagt
 * nichts über gekippte Lagen. Wörtlich genommen („Kurs der Oberkante“) wäre
 * die Ansicht beim Blick nach oben mit der alten Fassung immer um 180° verdreht
 * gewesen, was nie berichtet wurde. Es bleiben zwei Deutungen:
 *   A) Kurs wie ein erdfestes Euler-alpha, also −alpha,
 *   B) Kurs der Kamera (waagrechter Anteil der Geräte-−Z-Achse).
 * Sie unterscheiden sich um
 *   d = atan2(−sin γ, cos γ · sin β) = Kamerakurs − (−alpha),
 * im Hochformat ≈ atan(tan Rollwinkel / sin Blickhöhe): 9,9° bei 5° Roll und
 * 30° Höhe, 49,1° bei 30° Roll, 90° im Querformat.
 *
 * Deshalb: Der Kompass stellt ψ nur in Lagen nach, in denen beide Deutungen
 * höchstens 15° auseinanderliegen, und misst dort ihre Mitte. Der Fehler ist
 * damit unter jeder der beiden höchstens 7,5°; bei um null streuendem
 * Rollwinkel mittelt er sich großteils heraus (Prüfung 12: ±20° langsames
 * Rollen über 60 s höchstens 3,4°, 4° Roll dauerhaft gehalten 4,0°). Das
 * Gewicht fällt quadratisch zum Rand hin ab. Im Querformat und am Horizont mit
 * Rollwinkel ist d groß; dort trägt allein der Kreisel ψ weiter. Keine der
 * beiden Deutungen kann so einen Sprung auslösen: Die Abweichung erreicht das
 * Ausreißer-Tor (50°) gar nicht erst.
 * 15° lassen bei 30° Höhe bis 7,6° Rollwinkel zu, bei 45° bis 10,7°, bei 60°
 * bis 13,1°. Mit 10° (höchstens 5° Fehler) bekam eine übliche Handhaltung von
 * 5° Roll bei 30° Höhe (d = 9,9°) nur noch 2 % Gewicht: Der Nordbezug lief
 * nach einem Start am Horizont über 3 s kaum an (Prüfer-Szenario E). Mit 15°
 * sind es 56 %.
 *
 * Auflösbar nur am Gerät: 30° hoch blicken, Blickrichtung festhalten, um 30°
 * rollen. Ändert sich `webkitCompassHeading` dabei um rund 49°, gilt A; bleibt
 * er stehen, gilt B.
 */
const MAX_HEADING_SPREAD_RAD = 15 * DEG;

/**
 * Filter für den Fall ohne Kreiselstrom (nur `deviceorientationabsolute`):
 * dieselbe adaptive Dämpfung wie die bisherige Fassung (Gain 0,06 … 0,6 je
 * 60-Hz-Sample, Steigung 1,6 pro Radiant Abweichung), jetzt auf die Drehung um
 * den Zenit statt auf Euler-alpha angewandt. Ohne Filter stieg die Streuung
 * bei σ 2° Kursrauschen von 0,46° auf 0,61° (Prüfer-Messung, Prüfung 11).
 */
const BACKBONE_GAIN_MIN = 0.06;
const BACKBONE_GAIN_MAX = 0.6;
const BACKBONE_GAIN_SLOPE = 1.6;
/** Größter Zeitschritt des Rückgrat-Filters, wie in der bisherigen Fassung. */
const BACKBONE_MAX_STEP_S = 0.2;

export interface OrientationSample {
  /** Monotone Zeit in ms. */
  timeMs: number;
  /** Eventtyp. Von mehreren erdfesten Strömen wird nur der zuerst gesehene genutzt. */
  stream: string;
  alphaRad: number;
  betaRad: number;
  gammaRad: number;
  /** alpha bezieht sich auf Nord (Android `deviceorientationabsolute`), nicht auf einen Kreiselnullpunkt. */
  absolute: boolean;
  /** Magnetischer Kurs im Uhrzeigersinn aus demselben Event (iOS `webkitCompassHeading`). */
  compassHeadingRad: number | null;
  /**
   * `webkitCompassAccuracy` in Grad; `null` = unbekannt (dann voll gewichtet).
   * Negativ heißt laut Apple „nicht kalibriert, keine brauchbaren Werte“; WebKit
   * sendet so auch den Platzhalterkurs 0, solange noch kein CLHeading vorliegt.
   */
  compassAccuracyDeg?: number | null;
  /**
   * Magnetische Deklination am Standort, Ost positiv. Wirkt auf beide
   * magnetischen Quellen: Android `deviceorientationabsolute` und iOS
   * `webkitCompassHeading`, das WebKit immer aus `CLHeading.magneticHeading`
   * nimmt – nie aus `trueHeading`, auch nicht bei aktiver Ortung
   * (WebCoreMotionManager.mm, Z. 318).
   */
  declinationRad: number;
}

const sampleAttitude = new Quaternion();
const yawFix = new Quaternion();
const difference = new Quaternion();

/** Drehwinkel um den Zenit, der `from` auf `to` bringt – unabhängig vom Euler-Zweig beider Lagen. */
function yawBetween(to: Quaternion, from: Quaternion): number {
  difference.copy(from).invert().premultiply(to);
  return angleDelta(2 * Math.atan2(difference.y, difference.w), 0);
}

/**
 * Kursfusion: Die Lage kommt aus genau *einem* Kreiselstrom, der Nordbezug als
 * langsam nachgeführte Drehung ψ um den Zenit.
 *
 * Warum nicht mehr alpha selbst filtern: alpha ist nur ein Euler-Winkel. Steht
 * der Bildschirm senkrecht und ist das Gerät auch nur leicht gerollt, wechselt
 * die Zerlegung des Browsers bei kleinster Neigung den Zweig (alpha springt um
 * 180°, beta und gamma springen mit). Ein Tiefpass allein auf alpha trennt es
 * von beta/gamma und dreht die Ansicht für mehrere Frames weg. ψ dagegen ist
 * eine Drehung der ganzen Lage und zweigunabhängig; Drehungen des Geräts
 * laufen ungefiltert über den Kreisel.
 *
 * Kompass und Kreisel werden nie im selben Filter gemischt: Der Kompass stellt
 * nur ψ nach, fällt er aus, läuft die Anzeige mit dem letzten ψ weiter.
 *
 * ψ ändert sich nie sprunghaft – außer beim ersten Nordbezug innerhalb von
 * `REFERENCE_WAIT_MS` nach einem Start:
 * - Erster Start: Die Anzeige wartet still; der erste Nordbezug wird gesetzt,
 *   bevor irgendetwas angezeigt wurde.
 * - Nach einer Lücke über `SENSOR_TIMEOUT_MS`: Die Anzeige läuft sofort mit dem
 *   bisherigen Versatz weiter, statt das letzte Bild bis zu 1 s einzufrieren.
 *   Ein Nordbezug innerhalb der Frist ersetzt ihn direkt. Das ist ein Sprung
 *   der Ausgabe, aber der einzige und nur hier: Das Bild kommt ohnehin aus
 *   einem eingefrorenen Stand, und CameraRig führt die Kamera mit τ = 103 ms
 *   nach. Wurde der Kreiselnullpunkt nicht neu gesetzt, ist der Sprung nur das
 *   Kompassrauschen. In mehrdeutiger Lage kann stattdessen der Kompass den
 *   Versatz bis zum Fristende widerlegen oder wieder einsetzen (`checkResume`);
 *   auch diese Wechsel gibt es nur innerhalb der Frist.
 * Nach der Frist wird jeder Nordbezug mit höchstens 49,6°/s herangeführt.
 */
export class HeadingFusion {
  /** Nach Nord ausgerichtete Gerätelage im Szenensystem, ohne Bildschirmdrehung. */
  readonly attitude = new Quaternion();
  /** Die Lage hat einen erdfesten Nordbezug (sonst nur relativ zum Kreiselnullpunkt). */
  referenced = false;
  /** Kurskorrektur ψ in Radiant, Drehung um +Y (Zenit). */
  offset = 0;

  private offsetReady = false;
  /** ψ stützt sich bisher nur auf Messungen, die iOS nicht als kalibriert meldet. */
  private provisional = false;
  /** Die Anzeige lief ohne Nordbezug an; ψ wird begrenzt herangeführt statt gesetzt. */
  private acquiring = false;
  /** Seit dem letzten Neustart wurde schon eine Lage ausgegeben. */
  private shown = false;
  /**
   * Die Frist für den ersten Nordbezug ist ohne ihn abgelaufen, die Anzeige
   * läuft relativ: Ein Nordbezug wird ab jetzt herangeführt statt gesetzt.
   */
  private committed = false;
  /** Vor der Lücke lief schon eine Anzeige; sie wird ohne Wartezeit fortgesetzt. */
  private resuming = false;
  /** Versatz, mit dem die Anzeige nach der Lücke weiterläuft, bis ein Nordbezug kommt. */
  private resumeOffset: number | null = null;
  /** Die Anzeige vor der Lücke hatte einen Nordbezug; gilt `RESUME_STATUS_HOLD_MS` lang weiter. */
  private resumeReferenced = false;
  /** Versatz von vor der Lücke, gemerkt bei der ersten Prüfung; gegen ihn wird bis zum Fristende entschieden. */
  private resumeOriginal: number | null = null;
  /** Geglättete Kompass-Mitte seit der Lücke (`RESUME_SMOOTHING_S`); `null` = noch keine Prüfung. */
  private resumeMeasured: number | null = null;
  private resumeMeasuredMs = -Infinity;
  private readonly relative = new Quaternion();
  private readonly absolute = new Quaternion();
  private readonly absolutePrevious = new Quaternion();
  private relativeMs = -Infinity;
  /** Letzte Ausgabe mit dem erdfesten Strom als Rückgrat. */
  private backboneMs = -Infinity;
  private backboneReady = false;
  /** Gefilterter Kursversatz des erdfesten Rückgrats (φ), Drehung um +Y. */
  private backboneYaw = 0;
  private lastMs = -Infinity;
  private startMs = 0;
  private referenceMs = -Infinity;
  /** Zeitpunkt der letzten Drehung über `MAX_REFERENCE_RATE`. */
  private fastMs = -Infinity;
  private outlierSeconds: number | null = null;
  private outlierAnchor = 0;
  /** Beste Schätzung aus einer mehrdeutigen Lage, für den Anlauf ohne Nordbezug. */
  private guess: number | null = null;
  private absoluteStream: string | null = null;

  /** Verarbeitet ein Sample; `true`, wenn `attitude` neu und anzeigbar ist. */
  push(sample: OrientationSample): boolean {
    if (sample.absolute) {
      // Meldet ein Browser beide Eventtypen als erdfest, alternierten sonst zwei
      // leicht verschieden fusionierte Lagen pro Event.
      this.absoluteStream ??= sample.stream;
      if (sample.stream !== this.absoluteStream) return false;
    }
    if (sample.timeMs - this.lastMs > SENSOR_TIMEOUT_MS) this.restart(sample.timeMs);
    this.lastMs = sample.timeMs;

    eulerToAttitude(sampleAttitude, sample.alphaRad, sample.betaRad, sample.gammaRad);
    return sample.absolute ? this.pushAbsolute(sample) : this.pushRelative(sample);
  }

  private pushAbsolute(sample: OrientationSample): boolean {
    this.absolute
      .copy(sampleAttitude)
      .premultiply(yawFix.setFromAxisAngle(ZENITH, -sample.declinationRad));

    if (sample.timeMs - this.relativeMs <= SENSOR_TIMEOUT_MS) {
      // Der relative Strom trägt die Anzeige, dieser liefert nur den Nordbezug.
      // Android meldet keine Genauigkeit: voll gewichtet, als kalibriert.
      // Den ersten Nordbezug setzt er auch während einer Drehung (siehe
      // `correct`). Ohne ihn liefe die Anzeige am willkürlichen Nullpunkt des
      // relativen Stroms an (vorige Fassung: bis 180° daneben, 7,2 s bis unter
      // 2°). Sein Fehler ist die Drehung zwischen beiden Events (30°/s · 8 ms =
      // 0,24°, Prüfung 3g) plus ein etwaiger Latenzunterschied der beiden
      // Android-Sensoren – der ist nicht gemessen; die Nachführung nach der
      // Drehung beseitigt beides. iOS bleibt gesperrt: CLHeading ist eine eigene
      // Messung mit unbekannter Latenz (siehe MAX_REFERENCE_RATE; Prüfung 3i
      // nimmt 300 ms an, bei 60°/s wären das 18°).
      this.backboneReady = false;
      this.correct(yawBetween(this.absolute, this.relative), sample.timeMs, 1, true, true);
      return false;
    }

    // Ohne relativen Strom ist der erdfeste selbst das Rückgrat. Sein Kurs wird
    // wie in der bisherigen Fassung adaptiv gedämpft, aber als Drehung um den
    // Zenit (zweigunabhängig): φ ist der Abstand der Anzeige zum Rohkurs.
    // Neuer Rohkurs = alter + Δ; die Anzeige rückt um den Anteil k auf ihn zu:
    // φ' = (1 − k) · (φ − Δ).
    if (!this.backboneReady) {
      // Wechsel vom Kreisel-Rückgrat: dort weitermachen, wo die Anzeige steht.
      this.backboneYaw = this.shown ? yawBetween(this.attitude, this.absolute) : 0;
      this.backboneReady = true;
    } else {
      const dt = clamp((sample.timeMs - this.backboneMs) / 1000, 0, BACKBONE_MAX_STEP_S);
      const lag = angleDelta(this.backboneYaw - yawBetween(this.absolute, this.absolutePrevious), 0);
      const gain60 = clamp(
        BACKBONE_GAIN_MIN + Math.abs(lag) * BACKBONE_GAIN_SLOPE,
        BACKBONE_GAIN_MIN,
        BACKBONE_GAIN_MAX,
      );
      this.backboneYaw = lag * Math.pow(1 - gain60, dt * 60);
    }
    this.absolutePrevious.copy(this.absolute);
    this.backboneMs = sample.timeMs;

    // ψ verfällt; ein später einsetzender Kreiselstrom setzt an der Anzeige an.
    this.offsetReady = false;
    this.acquiring = false;
    this.offset = 0;
    this.referenced = true;
    this.attitude
      .copy(this.absolute)
      .premultiply(yawFix.setFromAxisAngle(ZENITH, this.backboneYaw));
    this.shown = true;
    return true;
  }

  private pushRelative(sample: OrientationSample): boolean {
    const dt = (sample.timeMs - this.relativeMs) / 1000;
    if (dt > 0 && Number.isFinite(dt) && sampleAttitude.angleTo(this.relative) / dt > MAX_REFERENCE_RATE) {
      this.fastMs = sample.timeMs;
    }
    this.relative.copy(sampleAttitude);
    this.relativeMs = sample.timeMs;
    // Trug vor der Lücke der erdfeste Strom die Anzeige, gibt es keinen Versatz
    // zu diesem Kreiselstrom; die Fortsetzung setzt dann an der letzten Anzeige an.
    if (this.resuming) this.resumeOffset ??= yawBetween(this.attitude, this.relative);

    if (!this.offsetReady && sample.timeMs - this.backboneMs <= SENSOR_TIMEOUT_MS) {
      // Wechsel vom erdfesten Rückgrat auf den Kreiselstrom: ψ so setzen, dass
      // die Anzeige nahtlos weiterläuft – kein Messwert, reine Stetigkeit.
      this.offset = yawBetween(this.attitude, this.relative);
      this.offsetReady = true;
      this.provisional = false;
      this.backboneReady = false;
    } else if (sample.compassHeadingRad !== null) {
      this.pushCompass(sample);
    }

    if (!this.offsetReady && !this.committed) {
      const waited = sample.timeMs - this.startMs >= REFERENCE_WAIT_MS;
      if (this.resuming) {
        // Nach einer Lücke sofort weiter, statt das letzte Bild eingefroren
        // stehen zu lassen (Prüfer: 1017 ms ohne Ausgabe, bis 94° daneben).
        this.offset = this.resumeOffset ?? this.offset;
      } else if (!waited) {
        // Erster Start: kurz auf den Nordbezug warten, statt erst relativ und
        // dann mit einem Schwenk erdfest anzuzeigen.
        return false;
      } else {
        // Anlauf ohne Nordbezug (Lage mehrdeutig oder Gerät nie ruhig): Statt
        // des willkürlichen Kreiselnullpunkts die letzte Mitte beider
        // Kompass-Deutungen. Unter beiden liegt sie höchstens um die halbe
        // Spreizung daneben (am Horizont mit 5° Roll 42,2° statt bis zu 180°,
        // Prüfer-Szenario E), dazu kommt der Zeitversatzfehler nahe β = 90°
        // (MIN_ALPHA_CONDITION). Sie ist nur ein Startwert, angezeigt als
        // relativ; der spätere Schwenk wird entsprechend kürzer.
        this.offset = this.guess ?? 0;
      }
      if (waited) this.committed = true;
    }

    this.referenced = this.offsetReady
      ? !this.acquiring
      : this.resumeReferenced && sample.timeMs - this.startMs < RESUME_STATUS_HOLD_MS;
    this.attitude.copy(this.relative).premultiply(yawFix.setFromAxisAngle(ZENITH, this.offset));
    this.shown = true;
    return true;
  }

  /**
   * iOS: Kompass und Kreisel stammen aus demselben Event und teilen beta und
   * gamma; der Versatz ist im Kern die alpha-Differenz. Wie stark die Messung
   * zählt, bestimmen Genauigkeit und Lage (siehe `MAX_HEADING_SPREAD_RAD`).
   */
  private pushCompass(sample: OrientationSample): void {
    const accuracy = sample.compassAccuracyDeg ?? null;
    let weight = 0;
    let calibrated = false;
    let measured = 0;
    let clearView = false;
    let halfSpread = 0;

    // accuracy < 0: WebKit-Platzhalter (Kurs 0, solange kein CLHeading vorliegt,
    // WebCoreMotionManager.mm Z. 318–319) oder laut Apple unbrauchbar. Verworfen.
    if (accuracy === null || accuracy >= 0) {
      calibrated = accuracy === null || accuracy <= MAX_COMPASS_ACCURACY_DEG;
      // Kalibrierte Messungen voll, schlechtere nach inverser Varianz relativ zur
      // Grenze: 50° Genauigkeit zählen ein Viertel, 100° ein Sechzehntel.
      const accuracyWeight = calibrated ? 1 : (MAX_COMPASS_ACCURACY_DEG / (accuracy ?? 1)) ** 2;

      const sinBeta = Math.sin(sample.betaRad);
      const cosBeta = Math.cos(sample.betaRad);
      const cosGamma = Math.cos(sample.gammaRad);
      // Kamerakurs − (−alpha), siehe MAX_HEADING_SPREAD_RAD.
      const spread = Math.atan2(-Math.sin(sample.gammaRad), cosGamma * sinBeta);
      halfSpread = Math.abs(spread) / 2;
      // Kurs im Uhrzeigersinn, alpha gegen ihn; Deklination macht aus
      // magnetisch geografisch Nord. Gemessen wird die Mitte beider Deutungen.
      measured = angleDelta(
        -(sample.compassHeadingRad ?? 0) - sample.declinationRad + spread / 2,
        sample.alphaRad,
      );
      clearView = Math.abs(cosBeta * cosGamma) <= NEAR_VERTICAL;
      if (clearView && !this.offsetReady) this.guess = measured;
      if (
        clearView &&
        Math.abs(cosBeta) >= MIN_ALPHA_CONDITION &&
        Math.abs(spread) <= MAX_HEADING_SPREAD_RAD
      ) {
        weight = accuracyWeight * (1 - (spread / MAX_HEADING_SPREAD_RAD) ** 2);
      }
    }
    this.correct(measured, sample.timeMs, weight, calibrated);

    // Fortsetzung nach einer Lücke, Lage mehrdeutig (sonst hätte `correct` den
    // Nordbezug schon gesetzt) und Gerät ruhig (sonst misst der Vergleich die
    // Kompasslatenz mit): bis zum Fristende mit jedem Sample prüfen, ob der
    // Kompass dem Versatz widerspricht (warum nicht nur einmal: siehe
    // `RESUME_SMOOTHING_S`).
    if (
      clearView &&
      this.resuming &&
      !this.offsetReady &&
      !this.committed &&
      sample.timeMs - this.fastMs >= REFERENCE_HOLD_MS
    ) {
      this.checkResume(measured, halfSpread, accuracy, sample.timeMs);
    }
  }

  /**
   * Prüft den nach einer Lücke fortgesetzten Versatz gegen die geglättete Mitte
   * beider Kompass-Deutungen (siehe `RESUME_TOLERANCE_DEG`, `RESUME_SMOOTHING_S`).
   * Die erste Prüfung entscheidet sofort mit ihrem Messwert, jede weitere neu mit
   * der nachgeführten Mitte – immer gegen den Versatz von vor der Lücke, nie
   * gegen eine frühere Mitte. Widerlegt: Die Anzeige läuft mit der Mitte weiter,
   * sonst mit dem alten Versatz. In beiden Fällen bleibt sie relativ, bis ein
   * Nordbezug kommt – bestätigen kann eine mehrdeutige Lage nichts.
   */
  private checkResume(measured: number, halfSpread: number, accuracy: number | null, timeMs: number): void {
    if (this.resumeMeasured === null) {
      this.resumeOriginal = this.resumeOffset;
      this.resumeMeasured = measured;
    } else {
      // Wie in `correct`: Längere Abstände (verworfene Samples) zählen höchstens
      // wie ein Sample bei 15 Hz.
      const dt = Math.min(MAX_REFERENCE_INTERVAL_S, (timeMs - this.resumeMeasuredMs) / 1000);
      const k = 1 - Math.exp(-dt / RESUME_SMOOTHING_S);
      this.resumeMeasured = angleDelta(this.resumeMeasured + angleDelta(measured, this.resumeMeasured) * k, 0);
    }
    this.resumeMeasuredMs = timeMs;

    const original = this.resumeOriginal ?? this.resumeMeasured;
    const tolerance = Math.max(RESUME_TOLERANCE_DEG, accuracy ?? 0) * DEG;
    if (Math.abs(angleDelta(original, this.resumeMeasured)) <= halfSpread + tolerance) {
      this.resumeOffset = original;
      return;
    }
    this.resumeOffset = this.resumeMeasured;
    this.resumeReferenced = false;
  }

  /**
   * Führt ψ mit einer Messung nach. `weight` ∈ [0, 1] skaliert die Schrittweite
   * (0 = Messung verwerfen), `calibrated` entscheidet, wie schnell die Messung
   * einen großen Versatz bestätigen darf. `firstWhileMoving`: Die Messung darf
   * den ersten Nordbezug auch während einer Drehung setzen (Android, erdfester
   * Strom); jede spätere Nachführung wartet die Ratensperre ab.
   */
  private correct(
    measured: number,
    timeMs: number,
    weight: number,
    calibrated: boolean,
    firstWhileMoving = false,
  ): void {
    const dt = Math.min(MAX_REFERENCE_INTERVAL_S, (timeMs - this.referenceMs) / 1000);
    this.referenceMs = timeMs;
    // Verworfene und ruhende Samples halten den Stand der Ausreißer-Bestätigung
    // nur an, statt ihn zurückzusetzen.
    if (!(weight > 0)) return;
    const first = !this.offsetReady && !this.committed;
    if (timeMs - this.fastMs < REFERENCE_HOLD_MS && !(first && firstWhileMoving)) return;

    if (!this.offsetReady) {
      this.offsetReady = true;
      this.outlierSeconds = null;
      if (first) {
        // Erster Nordbezug innerhalb der Frist: direkt setzen (siehe
        // Klassenkommentar). Auch eine unkalibrierte Messung ist besser als
        // keine; sie gilt aber als vorläufig und wird von der ersten
        // kalibrierten Abweichung ohne Wartezeit (begrenzt) korrigiert.
        this.offset = measured;
        this.provisional = !calibrated;
        return;
      }
      // Die Anzeige läuft schon relativ: den Nordbezug heranführen.
      this.acquiring = true;
    }

    const k = (1 - Math.exp(-dt / OFFSET_TIME_CONSTANT_S)) * weight;
    const innovation = angleDelta(measured, this.offset);
    const limited = clamp(innovation, -OUTLIER_GATE_RAD, OUTLIER_GATE_RAD);

    if (this.acquiring) {
      this.offset = angleDelta(this.offset + limited * k, 0);
      if (Math.abs(innovation) <= OUTLIER_GATE_RAD) {
        this.acquiring = false;
        this.provisional = !calibrated;
      }
      return;
    }

    if (Math.abs(innovation) <= OUTLIER_GATE_RAD) {
      this.outlierSeconds = null;
      if (calibrated) this.provisional = false;
      this.offset = angleDelta(this.offset + innovation * k, 0);
      return;
    }

    // Ausreißer.
    if (calibrated && this.provisional) {
      // ψ stammt nur aus unkalibrierten Messungen, die erste kalibrierte
      // Abweichung ist die bessere Auskunft: sofort, aber begrenzt folgen.
      this.offset = angleDelta(this.offset + limited * k, 0);
      return;
    }
    if (
      this.outlierSeconds === null ||
      Math.abs(angleDelta(measured, this.outlierAnchor)) > OUTLIER_GATE_RAD
    ) {
      this.outlierAnchor = measured;
      this.outlierSeconds = 0;
      return;
    }
    // Unkalibrierte Ausreißer zählen anteilig (OUTLIER_CONFIRM_UNCALIBRATED_S).
    this.outlierSeconds += calibrated ? dt : (dt * OUTLIER_CONFIRM_S) / OUTLIER_CONFIRM_UNCALIBRATED_S;
    if (this.outlierSeconds < OUTLIER_CONFIRM_S) return;
    this.offset = angleDelta(this.offset + Math.sign(innovation) * OUTLIER_FOLLOW_RATE * dt * weight, 0);
  }

  private restart(timeMs: number): void {
    // Lief vor der Lücke eine Anzeige, läuft sie sofort weiter. Trug der
    // Kreiselstrom sie, ist sein Versatz der beste Startwert: exakt, solange der
    // Nullpunkt blieb (blockierter Hauptthread); wurde er neu gesetzt
    // (App-Wechsel), ersetzt ihn der erste Nordbezug innerhalb der Frist, oder
    // der Kompass widerlegt ihn in mehrdeutiger Lage (`checkResume`).
    this.resuming = this.shown;
    this.resumeOffset = this.shown && this.relativeMs > this.backboneMs ? this.offset : null;
    this.resumeReferenced = this.shown && this.referenced;
    this.resumeOriginal = null;
    this.resumeMeasured = null;
    this.resumeMeasuredMs = -Infinity;
    this.committed = false;
    this.offsetReady = false;
    this.provisional = false;
    this.acquiring = false;
    this.shown = false;
    this.offset = 0;
    this.referenced = false;
    this.relativeMs = -Infinity;
    this.backboneMs = -Infinity;
    this.backboneReady = false;
    this.referenceMs = -Infinity;
    this.fastMs = -Infinity;
    this.outlierSeconds = null;
    this.guess = null;
    this.startMs = timeMs;
  }
}

/**
 * Glättungsrate der AR-Kamera: −60 · ln(1 − 0,15) = 9,75/s (τ = 103 ms). Das
 * entspricht bei 60 fps exakt dem bisherigen Schritt t = 0,15; ein Sprung ist
 * nach 0,31 s zu 95 % ausgeglichen – jetzt bei jeder Bildrate gleich schnell.
 */
export const AR_SMOOTHING_RATE = -60 * Math.log(1 - 0.15);

/**
 * Längster Frame-Abstand, der als Bildfolge gilt (10 fps). Längere Deltas
 * stammen aus Pausen (Tab-Wechsel, Sperrbildschirm); ungekappt ergäben sie
 * t = 1 und damit einen Sprung statt eines Schwenks. Unter 10 fps läuft die
 * Glättung deshalb in Bildern statt in Sekunden.
 */
const MAX_SMOOTHING_DELTA_S = 0.1;

/** Slerp-Anteil für einen Frame der Länge `deltaS`, unabhängig von der Bildrate. */
export function arSmoothingFactor(deltaS: number): number {
  const step = Math.min(Math.max(deltaS, 0), MAX_SMOOTHING_DELTA_S);
  return 1 - Math.exp(-step * AR_SMOOTHING_RATE);
}

/**
 * Restwinkel, ab dem die Übergabe von AR an Touch als abgeschlossen gilt:
 * 0,06° sind bei 70° Bildwinkel über 800 px Bildhöhe (Telefon hochkant) rund
 * zwei Drittel Pixel – das Ende der Überblendung ist nicht zu sehen.
 */
const HANDOVER_DONE_RAD = 1e-3;

/**
 * Übergabe der Kamera von AR an OrbitControls.
 *
 * OrbitControls richtet per lookAt ohne Rollwinkel aus; ohne Übergabe spränge
 * das Bild beim Verlassen von AR um den Rollwinkel des Geräts. Der Unterschied
 * zwischen letzter AR-Lage und erster lookAt-Lage wird deshalb als Versatz im
 * Kamerasystem gespeichert und klingt mit der AR-Glättungsrate ab – er liegt
 * *auf* der jeweils aktuellen lookAt-Lage. Zieht der Nutzer währenddessen,
 * folgt das Bild dem Finger ohne Nachlauf; die bisherige Fassung slerpte eine
 * eigene Lage hinter dem bewegten Ziel her (9,8° Nachlauf bei 104°/s, Übergabe
 * endete nie). Die Dauer ist fest: bei 15° Rollwinkel 34 Bilder (0,57 s).
 */
export class RollHandover {
  private readonly shown = new Quaternion();
  private readonly offset = new Quaternion();
  private readonly partial = new Quaternion();
  private pending = false;
  private angle = 0;
  private remaining = 0;

  get active(): boolean {
    return this.pending || this.remaining > 0;
  }

  /** Merkt sich die zuletzt gezeigte AR-Lage; der Versatz entsteht im nächsten `apply`. */
  begin(shown: Quaternion): void {
    this.shown.copy(shown);
    this.pending = true;
    this.remaining = 0;
  }

  cancel(): void {
    this.pending = false;
    this.remaining = 0;
  }

  /** Ergänzt die lookAt-Lage `camera` dieses Bildes um den abklingenden Versatz. */
  apply(camera: Quaternion, deltaS: number): void {
    if (this.pending) {
      this.offset.copy(camera).invert().multiply(this.shown);
      this.angle = 2 * Math.acos(Math.min(1, Math.abs(this.offset.w)));
      this.remaining = 1;
      this.pending = false;
    }
    if (this.remaining <= 0) return;
    this.remaining *= 1 - arSmoothingFactor(deltaS);
    if (this.remaining * this.angle < HANDOVER_DONE_RAD) {
      this.remaining = 0;
      return;
    }
    camera.multiply(this.partial.identity().slerp(this.offset, this.remaining));
  }
}

/**
 * Bereich, in dem die Pitch-Klammer vom Blick- auf den Bildschirm-oben-Kurs
 * überblendet (Tiefe unter dem Horizont). Oberhalb von 60° Tiefe zählt allein
 * die Blickrichtung – exakt wie in der bisherigen Fassung, der Kurs hängt dort
 * nicht vom Rollwinkel ab (normale Lesehaltung: rund 45° Tiefe). Ab 85° Tiefe
 * zählt allein die Bildschirm-Oben-Richtung; die Blickrichtung hat dort nur
 * noch cos 85° = 0,087 waagrechten Anteil und würde jedes Sensorrauschen
 * elffach in den Kurs tragen.
 */
const CLAMP_BLEND_START_RAD = 60 * DEG;
const CLAMP_BLEND_END_RAD = 85 * DEG;

const forward = new Vector3();
const upVector = new Vector3();
const lift = new Vector3();
const pitchTarget = new Vector3();
const pitchFix = new Quaternion();

/**
 * Hebt eine Blickrichtung unterhalb von `minElevation` auf den Horizont an.
 *
 * Wohin angehoben wird, bestimmt bis 60° Tiefe allein der Blickkurs: gedreht
 * wird dann um die waagrechte Achse senkrecht zum Blick, Kurs und Rollwinkel
 * bleiben exakt. Näher am Nadir hat der Blick keinen verlässlichen Kurs mehr;
 * bis 85° Tiefe wird deshalb (smoothstep) auf den Kurs der Bildschirm-Oben-
 * Richtung überblendet, die dort waagrecht liegt. Ohne Rollwinkel sind beide
 * Richtungen gleich.
 *
 * Eine Stelle ohne stetigen Kurs muss es geben (eine stetige Abbildung aller
 * Lagen auf einen Kurs, die am Horizont dem Blick folgt, existiert nicht). Sie
 * liegt hier bei Rollwinkel 180° in der Mitte der Überblendung (72,5° Tiefe):
 * Kamera fast senkrecht nach unten und dabei kopfüber. Die bisherige Fassung
 * hatte sie im Nadir selbst, die vorige Überarbeitung bei 51,8° Tiefe.
 *
 * Gedreht wird auf kürzestem Weg zum Zielpunkt am Horizont – *nicht* um die
 * lokale X-Achse der Kamera, die im Querformat schräg steht und dabei den
 * Azimut mitziehen würde.
 */
export function clampPitch(q: Quaternion, minElevation: number = AR_MIN_ELEVATION): void {
  forward.set(0, 0, -1).applyQuaternion(q);
  const horizontal = Math.hypot(forward.x, forward.z);
  const elevation = Math.atan2(forward.y, horizontal);
  if (elevation >= minElevation) return;

  const x = clamp(
    (-elevation - CLAMP_BLEND_START_RAD) / (CLAMP_BLEND_END_RAD - CLAMP_BLEND_START_RAD),
    0,
    1,
  );
  const blend = x * x * (3 - 2 * x);

  // Unter 85° Tiefe ist horizontal ≥ cos 85° = 0,087, die Division also sicher.
  lift.set(0, 0, 0);
  if (blend < 1) lift.set((forward.x / horizontal) * (1 - blend), 0, (forward.z / horizontal) * (1 - blend));
  if (blend > 0) {
    // Ab 60° Tiefe liegt Bildschirm-oben fast waagrecht: sein waagrechter Anteil
    // ist mindestens sin 60° = 0,87.
    upVector.set(0, 1, 0).applyQuaternion(q);
    const upHorizontal = Math.hypot(upVector.x, upVector.z);
    lift.x += (upVector.x / upHorizontal) * blend;
    lift.z += (upVector.z / upHorizontal) * blend;
    // Genau an der Unstetigkeitsstelle heben sich beide auf.
    if (lift.lengthSq() < 1e-12) lift.set(upVector.x, 0, upVector.z);
  }

  lift.normalize();
  pitchTarget.copy(lift).multiplyScalar(Math.cos(minElevation));
  pitchTarget.y = Math.sin(minElevation);
  pitchFix.setFromUnitVectors(forward, pitchTarget);
  q.premultiply(pitchFix);
}
