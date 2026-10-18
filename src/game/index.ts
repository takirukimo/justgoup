// Public API of the game simulation layer (pure TypeScript: no DOM, no three.js).

export { ClimberSim, type ClimberSimOptions, type SimStats } from './climber-sim';
export { Forearm } from './forearm';
export {
  generateBoulder,
  generateRopeRoute,
  generateCandidate,
  tutorialBoulder,
  dailyBoulder,
  dailyGrade,
  todayKey,
  TUTORIAL_SEQUENCE,
  type TutorialStep,
  type TutorialTeach,
} from './generator';
export {
  planBeta,
  planBetaDetailed,
  nextHint,
  estimateGrade,
  difficultyMetrics,
  StanceLab,
  SOLVER,
  SMEAR_ID,
  type PlanOptions,
  type PlanResult,
  type PlanStep,
  type DifficultyMetrics,
} from './solver';
export { scoreSend, scoreDaily, parTime, runGradeFor, scoreRope, SCORING } from './scoring';
export { RopeSystem, ROPE } from './rope';
export { gradeLabel, fontGrade, gradeColor, gradeWord } from './grades';
export { BetaBot, autoClimb, BOT, type BetaBotOptions } from './bot';
export { usableByHand, usableByFoot, contactPoint, clipPoint, startPlacement, topHolds } from './holds';
export {
  wallProfile,
  profileOf,
  makeProfile,
  panelAt,
  panelIndexAt,
  angleAt,
  smoothAngleAt,
  surfaceToLocal3D,
  local3DToSurface,
  normalAt,
  tangentAt,
  worldHeight,
  wallTopHeight,
  wallOverhang,
  panelSpans,
  panelsFromLengths,
  reachScale,
  surfaceDistance3D,
  steepestAngle,
  PROFILE_PRESETS,
  FOLD,
  type WallProfile,
  type PanelSpan,
  type ProfilePresetId,
  type Vec3,
  type SurfacePoint,
} from './wall-profile';
