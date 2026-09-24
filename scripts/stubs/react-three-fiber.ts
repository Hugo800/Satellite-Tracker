/**
 * Ersatz für @react-three/fiber in scripts/verify-rig.ts (esbuild --alias).
 * Die Prüfung ruft die Bildlogik von CameraRig direkt auf; gerendert wird dort
 * nichts, die Hooks dürfen also nie laufen.
 */
const unavailable = (name: string) => (): never => {
  throw new Error(`${name} ist in scripts/verify-rig.ts nicht verfügbar`);
};

export const useFrame = unavailable('useFrame');
export const useThree = unavailable('useThree');
