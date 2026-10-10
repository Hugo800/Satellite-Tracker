import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

export interface TextSpriteOptions {
  fontSize?: number;
  color?: string;
  glow?: string;
  bold?: boolean;
  padding?: number;
}

/**
 * Rendert Text in eine Canvas-Textur.
 *
 * Bewusst statt `troika-three-text`/drei-`<Text>`: Letzteres lädt seine
 * Default-Schrift zur Laufzeit von einem CDN und würde die Offline-Fähigkeit
 * der PWA brechen.
 */
export function createTextTexture(text: string, options: TextSpriteOptions = {}): CanvasTexture {
  const fontSize = options.fontSize ?? 96;
  const padding = options.padding ?? 24;
  const font = `${options.bold === false ? '500' : '700'} ${fontSize}px ui-monospace, "SF Mono", monospace`;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) throw new Error('2D-Kontext nicht verfügbar');
  measureCtx.font = font;
  const width = Math.ceil(measureCtx.measureText(text).width) + padding * 2;
  const height = fontSize + padding * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-Kontext nicht verfügbar');

  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = options.glow ?? 'rgba(56, 189, 248, 0.9)';
  ctx.shadowBlur = fontSize * 0.35;
  ctx.fillStyle = options.color ?? '#f5f5f7';
  ctx.fillText(text, width / 2, height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Seitenverhältnis einer Textur, um Sprites unverzerrt zu skalieren. */
export function textureAspect(texture: CanvasTexture): number {
  const image = texture.image as HTMLCanvasElement;
  return image.width / image.height;
}

/**
 * Wiederverwendbare Canvas-Textur für Labels im Vorhersage-Feature.
 * Deutlich günstiger als `createTextTexture`, da die Canvas wiederverwendet wird:
 * Das Glow wird einmal beim Erstellen eingestellt, `draw()` löscht nur und zeichnet neu.
 */
export function createReusableLabel(options: {
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
  glow?: string;
} = {}): {
  texture: CanvasTexture;
  draw(text: string): void;
  aspect: number;
  /** Breite des zuletzt gezeichneten Texts in Canvas-Pixeln – die bemalte Fläche, mittig in `width`. */
  readonly textWidth: number;
  dispose(): void;
} {
  const width = options.width ?? 512;
  const height = options.height ?? 64;
  const fontSize = options.fontSize ?? 44;
  const font = `700 ${fontSize}px ui-monospace, "SF Mono", monospace`;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D-Kontext nicht verfügbar');

  // Glow-Einstellungen einmalig, werden für jeden `draw`-Aufruf wiederverwendet
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = options.glow ?? 'rgba(56, 189, 248, 0.9)';
  ctx.shadowBlur = fontSize * 0.35;
  ctx.fillStyle = options.color ?? '#f5f5f7';

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  // Breite des gezeichneten Texts – TapPicker trifft Labels über ihre bemalte
  // Fläche, nicht über die ganze, meist leere Canvas.
  let textWidth = 0;

  // Wiederverwendbare Zeichenfunktion: Canvas löschen, neuen Text zeichnen, Textur aktualisieren
  const draw = (text: string): void => {
    // Canvas löschen
    ctx.clearRect(0, 0, width, height);
    // Text zeichnen (Glow-Einstellungen sind bereits gesetzt)
    ctx.fillText(text, width / 2, height / 2);
    textWidth = Math.min(width, ctx.measureText(text).width);
    // Textur aktualisieren
    texture.needsUpdate = true;
  };

  return {
    texture,
    draw,
    aspect: width / height,
    get textWidth(): number {
      return textWidth;
    },
    dispose(): void {
      texture.dispose();
      // Canvas wird durch die Garbage Collection aufgeräumt, wenn die Textur gelöscht ist
    },
  };
}
