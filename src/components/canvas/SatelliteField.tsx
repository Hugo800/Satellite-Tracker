import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  ShaderMaterial,
} from 'three';
import { GROUP_COLORS, GROUP_ORDER, SKY_RADIUS } from '../../data/groups';
import { azElToVector, clamp } from '../../math/coords';
import {
  TELEMETRY_STRIDE,
  T_AZ,
  T_ECLIPSED,
  T_EL,
  T_MAG,
  T_RANGE,
} from '../../math/telemetryLayout';
import { passesSkyFilter } from '../../math/visibility';
import { catalogIndex, telemetry } from '../../state/runtime';
import { useAppStore } from '../../state/store';
import {
  createSatelliteDotTexture,
  createSatelliteTexture,
  createSelectionTexture,
} from './satelliteTextures';

/** Restlicht für Satelliten im Erdschatten – sichtbar, aber klar abgesetzt. */
const ECLIPSE_FACTOR = 0.3;

/** Instanz-Kapazität wächst in diesen Blöcken, damit Neuaufbauten selten bleiben. */
const CAPACITY_CHUNK = 2048;

/** Bildwinkel, bei dem die Symbolgröße ihrem Nennwert entspricht. */
const REFERENCE_FOV_DEG = 70;
const REFERENCE_HALF_TAN = Math.tan((REFERENCE_FOV_DEG * Math.PI) / 360);

const vertexShader = /* glsl */ `
  attribute vec2 aPrev;
  attribute vec2 aCur;
  attribute vec3 aColor;
  attribute float aSize;

  uniform float uT;
  uniform float uRadius;
  uniform float uSizeScale;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vVisible;

  const float PI = 3.141592653589793;
  const float TAU = 6.283185307179586;

  void main() {
    // aSize == 0 heißt: von Filter oder Horizont ausgeschlossen. Das Quad wandert
    // dann aus dem Clip-Volumen – kein Fragment, kein Blending, kein Sortieraufwand.
    if (aSize <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vUv = vec2(0.0);
      vColor = vec3(0.0);
      vVisible = 0.0;
      return;
    }

    // Zwischen zwei Telemetrie-Ticks wird auf der GPU interpoliert; der Azimut
    // nimmt dabei den kürzeren der beiden Wege über den Nordpunkt.
    float dAz = aCur.x - aPrev.x;
    dAz -= TAU * floor((dAz + PI) / TAU);
    float az = aPrev.x + dAz * uT;
    float el = aPrev.y + (aCur.y - aPrev.y) * uT;

    float cosEl = cos(el);
    vec3 centre = uRadius * vec3(cosEl * sin(az), sin(el), -cosEl * cos(az));

    // Bildschirmparalleles Billboard: Der Versatz wirkt im View-Space, also
    // ohne die Kamera-Quaternion je Instanz auf der CPU anfassen zu müssen.
    //
    // uSizeScale haelt die Groesse in *Pixeln* konstant, statt in Weltmassen:
    // Ohne diesen Faktor wüchse jeder Punkt beim Hineinzoomen mit, und aus
    // einem dichten Feld würde eine geschlossene Leuchtfläche – bei 22° statt
    // 70° Bildwinkel rund das Zehnfache an überlagerten Fragmenten. So
    // trennen sich enge Gruppen beim Zoomen stattdessen auf.
    vec4 mv = modelViewMatrix * vec4(centre, 1.0);
    mv.xy += position.xy * aSize * uSizeScale;
    gl_Position = projectionMatrix * mv;

    vUv = uv;
    vColor = aColor;
    vVisible = 1.0;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vVisible;

  void main() {
    if (vVisible < 0.5) discard;
    vec4 texel = texture2D(uMap, vUv);
    float alpha = texel.a * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(vColor * texel.rgb, alpha);
    #include <colorspace_fragment>
  }
`;

interface InstanceBuffers {
  capacity: number;
  geometry: InstancedBufferGeometry;
  prev: InstancedBufferAttribute;
  cur: InstancedBufferAttribute;
  color: InstancedBufferAttribute;
  size: InstancedBufferAttribute;
}

function createBuffers(capacity: number, quad: PlaneGeometry): InstanceBuffers {
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.setAttribute('uv', quad.getAttribute('uv'));

  const prev = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const cur = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
  const color = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
  const size = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  for (const attribute of [prev, cur, color, size]) attribute.setUsage(DynamicDrawUsage);

  geometry.setAttribute('aPrev', prev);
  geometry.setAttribute('aCur', cur);
  geometry.setAttribute('aColor', color);
  geometry.setAttribute('aSize', size);
  geometry.instanceCount = 0;
  // Die Instanzen liegen auf einer Kugel um die Kamera – Frustum-Culling der
  // Gesamtgeometrie brächte nichts und würde bei leerer Bounding-Box schaden.
  geometry.boundingSphere = null;

  return { capacity, geometry, prev, cur, color, size };
}

/**
 * Massen-Rendering **aller** Katalogobjekte in einem einzigen Draw-Call.
 *
 * Die frühere Fassung schrieb pro Frame eine 4×4-Matrix je Instanz auf die CPU
 * und lud sie hoch – bei 12 000 Objekten wären das 46 MB/s allein an
 * Instanzmatrizen. Hier wandern nur noch vier kleine Attribute (Vorgänger- und
 * Zielwinkel, Farbe, Größe) und das im Takt der Telemetrie, also mit 10 Hz.
 * Interpolation, Kugelprojektion und Billboarding erledigt der Vertex-Shader,
 * sodass pro Frame lediglich ein einzelnes `uT`-Uniform zu setzen ist.
 *
 * Es gibt bewusst **keine** Obergrenze für die Instanzzahl: Die Kapazität
 * wächst in Blöcken mit dem Katalog mit.
 */
export function SatelliteField(): React.JSX.Element {
  const meshRef = useRef<Mesh>(null);
  const selectionRef = useRef<Mesh>(null);
  const camera = useThree((s) => s.camera);

  const catalog = useAppStore((s) => s.catalog);
  const mode = useAppStore((s) => s.filters.mode);
  const selectedIndex = useAppStore((s) => s.selectedIndex);

  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedIndex);
  modeRef.current = mode;
  selectedRef.current = selectedIndex;

  const dotTexture = useMemo(createSatelliteDotTexture, []);
  const iconTexture = useMemo(createSatelliteTexture, []);
  const selectionTexture = useMemo(createSelectionTexture, []);
  const quad = useMemo(() => new PlaneGeometry(1, 1), []);

  const palette = useMemo(() => GROUP_ORDER.map((g) => new Color(GROUP_COLORS[g])), []);

  // Wenige, große Objekte vertragen das detaillierte Symbol; bei Hunderten
  // gleichzeitig ist ein Leuchtpunkt deutlich lesbarer.
  const detailed = mode === 'nakedEye';
  const activeTexture = detailed ? iconTexture : dotTexture;
  const baseSize = detailed ? 34 : 24;
  const baseSizeRef = useRef(baseSize);
  baseSizeRef.current = baseSize;

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
          uT: { value: 0 },
          uRadius: { value: SKY_RADIUS },
          uSizeScale: { value: 1 },
          uMap: { value: dotTexture },
          uOpacity: { value: 1 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    [dotTexture],
  );

  useEffect(() => {
    material.uniforms.uMap.value = activeTexture;
  }, [material, activeTexture]);

  /** Kapazität in Blöcken – ein Katalogzuwachs baut die Attribute nur selten neu auf. */
  const capacity = Math.max(
    CAPACITY_CHUNK,
    Math.ceil(Math.max(catalog.length, telemetry.count) / CAPACITY_CHUNK) * CAPACITY_CHUNK,
  );

  const buffers = useMemo(() => createBuffers(capacity, quad), [capacity, quad]);

  useEffect(() => () => buffers.geometry.dispose(), [buffers]);

  useEffect(
    () => () => {
      dotTexture.dispose();
      iconTexture.dispose();
      selectionTexture.dispose();
      quad.dispose();
      material.dispose();
    },
    [dotTexture, iconTexture, selectionTexture, quad, material],
  );

  const frameState = useRef({ revision: -1, elapsed: 0, visible: 0, mode: '' });

  // Der Ring richtet sich erst beim Zeichnen nach der Kamera aus. Im Frame-Takt
  // (Priorität 0) läuft er vor dem CameraRig und sähe nach dem Verlassen von AR
  // die rollfreie lookAt-Lage statt der gezeigten (bis 12,75° verdreht).
  useEffect(() => {
    const ring = selectionRef.current;
    if (!ring) return;
    ring.onBeforeRender = (_renderer, _scene, renderCamera) => {
      ring.quaternion.copy(renderCamera.quaternion);
      ring.updateMatrixWorld();
    };
    return () => {
      ring.onBeforeRender = () => {};
    };
  }, []);

  // Neue Attribut-Buffer starten leer; der nächste Tick muss sie vollständig
  // befüllen, sonst stünden alte Winkel an neuen Plätzen.
  useEffect(() => {
    frameState.current.revision = -1;
  }, [buffers]);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const state = frameState.current;
    const count = Math.min(telemetry.count, buffers.capacity);
    buffers.geometry.instanceCount = count;
    if (count === 0) return;

    const activeMode = modeRef.current;

    if (state.revision !== telemetry.revision || state.mode !== activeMode) {
      const first = state.revision === -1;
      const data = telemetry.data;
      const prev = buffers.prev.array as Float32Array;
      const cur = buffers.cur.array as Float32Array;
      const colors = buffers.color.array as Float32Array;
      const sizes = buffers.size.array as Float32Array;
      const groupIds = catalogIndex.groupIds;
      const starlinkFlags = catalogIndex.starlink;

      // Stehen tausende Objekte gleichzeitig über dem Horizont, werden die
      // Symbole kleiner statt weniger – gezeigt wird weiterhin ausnahmslos
      // jedes davon. Die Bezugsgröße stammt aus dem vorigen Takt: Die Zahl
      // sichtbarer Objekte ändert sich über Minuten, nicht über 100 ms, und so
      // bleibt es bei einem einzigen Durchlauf über den Katalog.
      const crowding = clamp(1 - 0.34 * Math.log10(Math.max(1, state.visible / 140)), 0.42, 1);
      const size = baseSizeRef.current * crowding;
      let visible = 0;

      for (let i = 0; i < count; i += 1) {
        const base = i * TELEMETRY_STRIDE;
        const elevation = data[base + T_EL];
        const eclipsed = data[base + T_ECLIPSED] > 0.5;
        const magnitude = data[base + T_MAG];
        const groupId = groupIds[i] ?? 0;

        // Die Winkelhistorie wird für *jede* Instanz fortgeschrieben, auch für
        // gerade ausgeblendete. Sonst stünde in `cur` beim Wiederauftauchen
        // über dem Horizont ein beliebig alter Wert, und die Instanz zöge einen
        // Frame lang quer über den Himmel.
        const azimuth = data[base + T_AZ];
        if (first) {
          prev[i * 2] = azimuth;
          prev[i * 2 + 1] = elevation;
        } else {
          prev[i * 2] = cur[i * 2];
          prev[i * 2 + 1] = cur[i * 2 + 1];
        }
        cur[i * 2] = azimuth;
        cur[i * 2 + 1] = elevation;

        const show =
          Number.isFinite(data[base + T_RANGE]) &&
          passesSkyFilter(activeMode, starlinkFlags[i] === 1, elevation, eclipsed, magnitude);

        if (!show) {
          sizes[i] = 0;
          continue;
        }
        visible += 1;

        // Hellere Objekte wirken größer; horizontnahe werden leicht gedämpft.
        const brightnessScale = clamp(1.5 - 0.1 * (magnitude - 1), 0.85, 1.7);
        const horizonFade = 0.78 + 0.22 * Math.min(1, elevation / 0.35);
        sizes[i] = size * brightnessScale * horizonFade * (eclipsed ? 0.8 : 1);

        const tint = palette[groupId] ?? palette[0];
        const shade = eclipsed ? ECLIPSE_FACTOR : 0.88 + 0.12 * horizonFade;
        colors[i * 3] = tint.r * shade;
        colors[i * 3 + 1] = tint.g * shade;
        colors[i * 3 + 2] = tint.b * shade;
      }

      buffers.prev.addUpdateRange(0, count * 2);
      buffers.cur.addUpdateRange(0, count * 2);
      buffers.color.addUpdateRange(0, count * 3);
      buffers.size.addUpdateRange(0, count);
      buffers.prev.needsUpdate = true;
      buffers.cur.needsUpdate = true;
      buffers.color.needsUpdate = true;
      buffers.size.needsUpdate = true;

      state.revision = telemetry.revision;
      state.mode = activeMode;
      state.visible = visible;
      state.elapsed = 0;
    }

    state.elapsed += delta * 1000;
    const t = Math.min(1, state.elapsed / Math.max(16, telemetry.intervalMs));
    material.uniforms.uT.value = t;

    // Beim Zoomen bleibt die Bildschirmgröße der Symbole gleich (siehe Shader).
    const fovDeg = (camera as PerspectiveCamera).fov ?? REFERENCE_FOV_DEG;
    const sizeScale = Math.tan((fovDeg * Math.PI) / 360) / REFERENCE_HALF_TAN;
    material.uniforms.uSizeScale.value = sizeScale;

    /* --- Auswahlring: ein einzelnes Objekt, deshalb weiterhin auf der CPU --- */
    const ring = selectionRef.current;
    const selected = selectedRef.current;
    if (!ring) return;

    if (selected === null || selected >= count || buffers.size.array[selected] <= 0) {
      ring.visible = false;
      return;
    }

    const prev = buffers.prev.array as Float32Array;
    const cur = buffers.cur.array as Float32Array;
    let dAz = cur[selected * 2] - prev[selected * 2];
    dAz -= Math.PI * 2 * Math.floor((dAz + Math.PI) / (Math.PI * 2));
    const az = prev[selected * 2] + dAz * t;
    const el = prev[selected * 2 + 1] + (cur[selected * 2 + 1] - prev[selected * 2 + 1]) * t;

    azElToVector(az, el, SKY_RADIUS, ring.position);
    ring.scale.setScalar(Math.max(26, buffers.size.array[selected] * 2.6) * sizeScale);
    ring.visible = true;
  });

  return (
    <group>
      <mesh
        ref={meshRef}
        geometry={buffers.geometry}
        material={material}
        frustumCulled={false}
        renderOrder={5}
      />

      <mesh ref={selectionRef} geometry={quad} visible={false} renderOrder={6}>
        <meshBasicMaterial
          map={selectionTexture}
          color="#ff375f"
          transparent
          depthWrite={false}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
