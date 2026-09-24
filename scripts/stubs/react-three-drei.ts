/**
 * Ersatz für @react-three/drei in scripts/verify-rig.ts (esbuild --alias). Das
 * echte OrbitControls aus three-stdlib bindet die Prüfung selbst ein; den
 * Frame-Takt des drei-Wrappers (update bei Priorität −1) bildet sie nach.
 */
export const OrbitControls = (): never => {
  throw new Error('OrbitControls (drei) ist in scripts/verify-rig.ts nicht verfügbar');
};
