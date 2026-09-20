import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

const SIZE = 128;

function createCanvas(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-Kontext nicht verfügbar');
  return ctx;
}

function toTexture(ctx: CanvasRenderingContext2D): CanvasTexture {
  const texture = new CanvasTexture(ctx.canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Weicher Halo, damit die Symbole auch klein noch „leuchten“. */
function drawGlow(ctx: CanvasRenderingContext2D, radius: number, strength: number): void {
  const gradient = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, radius);
  gradient.addColorStop(0, `rgba(255,255,255,${strength})`);
  gradient.addColorStop(0.45, `rgba(255,255,255,${strength * 0.28})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

/**
 * Generisches Satellitensymbol: Rumpf mit zwei Solarpaneelen.
 *
 * Bewusst in Weiß gezeichnet – die Einfärbung pro Objekt übernimmt
 * `instanceColor` der InstancedMesh.
 */
export function createSatelliteTexture(): CanvasTexture {
  const ctx = createCanvas();
  const c = SIZE / 2;

  drawGlow(ctx, 60, 0.5);

  ctx.fillStyle = '#ffffff';
  // Rumpf
  ctx.fillRect(c - 9, c - 11, 18, 22);

  // Solarpaneele
  ctx.globalAlpha = 0.92;
  ctx.fillRect(c - 44, c - 8, 30, 16);
  ctx.fillRect(c + 14, c - 8, 30, 16);

  // Zellentrennung
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  for (const offset of [-36, -28, -20, 20, 28, 36]) {
    ctx.beginPath();
    ctx.moveTo(c + offset, c - 8);
    ctx.lineTo(c + offset, c + 8);
    ctx.stroke();
  }

  // Antennenausleger
  ctx.globalAlpha = 0.85;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(c, c - 11);
  ctx.lineTo(c, c - 22);
  ctx.stroke();

  ctx.globalAlpha = 1;
  return toTexture(ctx);
}

/**
 * Kompakter Leuchtpunkt für Massenobjekte. Bei mehreren hundert gleichzeitig
 * sichtbaren Satelliten ist ein Punkt lesbarer als ein detailliertes Symbol.
 */
export function createSatelliteDotTexture(): CanvasTexture {
  const ctx = createCanvas();
  const c = SIZE / 2;

  drawGlow(ctx, 58, 0.62);

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(c, c, 11, 0, Math.PI * 2);
  ctx.fill();

  // Kurze Querstriche deuten die Solarpaneele an.
  ctx.globalAlpha = 0.9;
  ctx.fillRect(c - 26, c - 3, 12, 6);
  ctx.fillRect(c + 14, c - 3, 12, 6);

  ctx.globalAlpha = 1;
  return toTexture(ctx);
}

/** Auffälliges Symbol mit Zielring für ISS, Tiangong, Hubble & Co. */
export function createStationTexture(): CanvasTexture {
  const ctx = createCanvas();
  const c = SIZE / 2;

  drawGlow(ctx, 64, 0.62);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(c - 7, c - 14, 14, 28);
  ctx.fillRect(c - 50, c - 10, 34, 20);
  ctx.fillRect(c + 16, c - 10, 34, 20);

  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  for (const offset of [-42, -33, -24, 24, 33, 42]) {
    ctx.beginPath();
    ctx.moveTo(c + offset, c - 10);
    ctx.lineTo(c + offset, c + 10);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, 54, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 1;
  return toTexture(ctx);
}

/** Ringmarkierung für das aktuell ausgewählte Objekt. */
export function createSelectionTexture(): CanvasTexture {
  const ctx = createCanvas();
  const c = SIZE / 2;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(c, c, 46, 0, Math.PI * 2);
  ctx.stroke();

  // Vier Fadenkreuz-Marken
  ctx.lineWidth = 5;
  for (let i = 0; i < 4; i += 1) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(angle) * 38, c + Math.sin(angle) * 38);
    ctx.lineTo(c + Math.cos(angle) * 56, c + Math.sin(angle) * 56);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  return toTexture(ctx);
}
