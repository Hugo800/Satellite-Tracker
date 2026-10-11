import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { PerspectiveCamera } from 'three';

/**
 * Hält das Himmelsbild deckungsgleich mit dem sichtbaren Bereich, wenn der
 * Canvas im Safari-Tab über #root hinaus unter die Leisten ragt
 * (src/utils/skyBleed.ts).
 *
 * Ohne Ausgleich verteilte die Kamera ihr Sichtfeld auf den ganzen, höheren
 * Canvas: Alles erschiene kleiner, und die Blickmitte rutschte um die halbe
 * Differenz der Ränder aus der Bildschirmmitte. Stattdessen rechnet die Kamera
 * mit dem sichtbaren Bereich als Bild und zeichnet per `setViewOffset` nur den
 * Ausschnitt größer – Sichtfeld, Maßstab und Mitte bleiben wie ohne Rand, und
 * alles, was über die Projektionsmatrix geht (Antippen, Beschriftungen),
 * stimmt weiter.
 *
 * Die Lage wird nur bei geänderter Canvas-Größe neu gemessen, die Kamera aber
 * jedes Bild geprüft, weil react-three-fiber beim Resize `aspect` auf das
 * Canvas-Verhältnis zurücksetzt.
 */
export function BleedView(): null {
  const gl = useThree((s) => s.gl);
  const measured = useRef({ width: -1, height: -1, top: 0, visible: 0 });

  useFrame(({ camera, size }) => {
    const cam = camera as PerspectiveCamera;
    const m = measured.current;
    if (m.width !== size.width || m.height !== size.height) {
      const root = document.getElementById('root');
      if (!root) return;
      const rootRect = root.getBoundingClientRect();
      m.width = size.width;
      m.height = size.height;
      m.top = Math.round(rootRect.top - gl.domElement.getBoundingClientRect().top);
      m.visible = Math.round(rootRect.height);
    }
    const { top, visible } = m;

    if (top === 0 && visible === size.height) {
      if (cam.view?.enabled) {
        cam.clearViewOffset();
        cam.aspect = size.width / size.height;
        cam.updateProjectionMatrix();
      }
      return;
    }

    const view = cam.view;
    if (
      view?.enabled &&
      view.fullWidth === size.width &&
      view.fullHeight === visible &&
      view.offsetY === -top &&
      view.height === size.height &&
      cam.aspect === size.width / visible
    ) {
      return;
    }
    cam.setViewOffset(size.width, visible, 0, -top, size.width, size.height);
  });

  return null;
}
