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
