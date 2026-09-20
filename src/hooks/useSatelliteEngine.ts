import { useEffect, useRef } from 'react';
import { telemetry, trailState } from '../state/runtime';
import { useAppStore } from '../state/store';
import type { SatelliteGroup, WorkerRequest, WorkerResponse } from '../types';

let workerSingleton: Worker | null = null;

function send(message: WorkerRequest): void {
  workerSingleton?.postMessage(message);
}

/** Imperative API des SGP4-Workers – bewusst außerhalb von React. */
export const engine = {
  requestTrail(index: number, fromMin = -25, toMin = 70, samples = 220): void {
    send({ type: 'trail', index, fromMin, toMin, samples });
  },
  requestPass(index: number, searchHours = 48): void {
    send({ type: 'pass', index, searchHours });
  },
  setTimeScale(value: number): void {
    send({ type: 'timeScale', value });
  },
  reload(groups: SatelliteGroup[]): void {
    send({ type: 'load', groups });
  },
};

export interface EngineOptions {
  /** Propagations-Rate in ms. 100 ms = 10 Hz, dazwischen wird im Shader interpoliert. */
  intervalMs?: number;
}

/**
 * Startet den SGP4-Worker, hält ihn mit dem Beobachterstandort synchron und
 * schreibt eingehende Telemetrie direkt in den Modulzustand (kein React-Render).
 */
export function useSatelliteEngine({ intervalMs = 100 }: EngineOptions = {}): void {
  const observer = useAppStore((s) => s.observer);
  const activeGroups = useAppStore((s) => s.activeGroups);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const setStatus = useAppStore((s) => s.setStatus);
  const pushError = useAppStore((s) => s.pushError);
  const setPass = useAppStore((s) => s.setPass);
  const started = useRef(false);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/sgp4.worker.ts', import.meta.url), {
      type: 'module',
      name: 'sgp4',
    });
    workerSingleton = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'tick':
          telemetry.data = new Float32Array(msg.buffer);
          telemetry.count = msg.count;
          telemetry.timeMs = msg.time;
          telemetry.revision += 1;
          break;
        case 'catalog':
          setCatalog(msg.catalog);
          break;
        case 'status':
          setStatus(msg.message, msg.loading);
          break;
        case 'trail':
          trailState.index = msg.index;
          trailState.points = msg.points;
          trailState.version += 1;
          break;
        case 'pass':
          setPass(msg.pass);
          break;
        case 'error':
          pushError(msg.message);
          break;
      }
    };

    worker.onerror = (event) => pushError(`Worker-Fehler: ${event.message}`);

    return () => {
      worker.terminate();
      workerSingleton = null;
      started.current = false;
      telemetry.count = 0;
      telemetry.data = new Float32Array(0);
    };
  }, [setCatalog, setStatus, pushError, setPass]);

  useEffect(() => {
    if (!observer) return;
    send({ type: 'observer', observer });
    if (!started.current) {
      send({ type: 'start', intervalMs });
      started.current = true;
    }
  }, [observer, intervalMs]);

  // Strikt getrennt vom Standort-Effekt: ein Katalog-Reload verwirft im Worker
  // alle Satelliten und darf deshalb nicht an jedem GPS-Fix hängen.
  useEffect(() => {
    send({ type: 'load', groups: activeGroups });
  }, [activeGroups]);
}
