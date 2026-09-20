import { Quaternion, Vector3 } from 'three';

/**
 * Tiefster Blickwinkel im AR-Modus. Die Ansicht ist auf die obere Halbkugel
 * beschränkt: Zeigt das Gerät unter den Horizont, rastet das Bild dort ein,
 * statt in die Bodenebene weiterzudrehen.
 */
export const AR_MIN_ELEVATION = 0;

const forward = new Vector3();
const upVector = new Vector3();
const pitchAxis = new Vector3();
const pitchFix = new Quaternion();

/**
 * Hebt eine Blickrichtung unterhalb von `minElevation` auf den Horizont an,
 * ohne Kurs und Rollwinkel zu verfälschen.
 *
 * Gedreht wird um die Normale der Vertikalebene der Blickrichtung – *nicht* um
 * die lokale X-Achse der Kamera, die im Querformat schräg steht und dabei den
 * Azimut mitziehen würde.
 */
export function clampPitch(q: Quaternion, minElevation: number = AR_MIN_ELEVATION): void {
  forward.set(0, 0, -1).applyQuaternion(q);
  const horizontal = Math.hypot(forward.x, forward.z);
  const elevation = Math.atan2(forward.y, horizontal);
  if (elevation >= minElevation) return;

  if (horizontal > 1e-4) {
    pitchAxis.set(-forward.z, 0, forward.x);
  } else {
    // Exakt senkrechter Blick: Kurs aus der Bildschirm-Oben-Richtung ableiten.
    upVector.set(0, 1, 0).applyQuaternion(q);
    pitchAxis.set(-upVector.z, 0, upVector.x);
  }
  if (pitchAxis.lengthSq() < 1e-8) return;

  pitchFix.setFromAxisAngle(pitchAxis.normalize(), minElevation - elevation);
  q.premultiply(pitchFix);
}
