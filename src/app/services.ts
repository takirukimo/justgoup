// The concrete subsystems the app wires together, handed to sessions and runs.

import type { BackendAPI } from '../core/contracts';
import type { Profile } from '../core/types';
import type { GameRenderer } from '../render/renderer';
import type { LimbControls } from '../input/limb-controls';
import type { GameUI } from '../ui/ui';
import type { GameAudio } from '../audio/audio';
import type { ProblemFactory } from './gen';
import type { HintGhost, Veil } from './overlays';

export interface Services {
  readonly renderer: GameRenderer;
  readonly controls: LimbControls;
  readonly ui: GameUI;
  readonly audio: GameAudio;
  readonly gen: ProblemFactory;
  readonly veil: Veil;
  readonly ghost: HintGhost;
  /** Element the canvas / overlays live in (#app). */
  readonly host: HTMLElement;
  /** The live profile (mutated in place by the app; call save() after changes). */
  profile(): Profile;
  save(): void;
  backend(): BackendAPI | null;
  /** Resolves once the backend is chosen. */
  backendReady(): Promise<BackendAPI>;
  /** Debug time scale for the simulation and session beats (1 in production). */
  readonly timeScale: number;
}
