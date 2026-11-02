/**
 * 《螞蟻帝國》simulation engine — public API.
 *
 * Pure TypeScript, no DOM and no Node APIs: the same module loads in Node (official advancement) and,
 * later, in a browser (read-only viewer). All numbers come from species/<id>.json and world/<id>.json.
 */
export { ENGINE_VERSION, ENGINE_IMPLEMENTATION, NATURAL_EVENT_TYPES, simulateWorldDay, runWorldDay, validateWorld } from './day.ts';
export type { WorldDayResult, ColonyDayResult } from './day.ts';
export { simulateDay, legacyToWorldState, legacyView, legacyColonyMeta } from './legacy.ts';
export type { LegacyV2State, LegacyDayOutput } from './legacy.ts';
export { migrationState, metadataPreview } from './migration.ts';
export { initializeDay0, FoundingNotSupported } from './initialization.ts';
export type { Day0Input, Day0Output } from './initialization.ts';
export type { MigrationRefs } from './migration.ts';
export { resolveBundle, resolveSpecies, resolveWorld, validateParamTree, num, ALLOWED_BASIS } from './params.ts';
export type { ParamBundle, ParamFile, SpeciesParams, WorldParams, ScenarioColony } from './params.ts';
export { foragingTemperatureFactor, localSignals, selectTask } from './workers.ts';
export { routeTo, routeEdges, travel, goHome, adjacencyOf, edgeKey } from './routes.ts';
export { decayTrails, depositTrail, fullTrail, followLocalTrail } from './trails.ts';
export { handoff, settleCrops, consume, storageOverflow } from './nutrition.ts';
export { prey, forageDay, huntWindow, huntable, type Arrival, type Carry, type HuntContext } from './foraging.ts';
export { growEcology, sourceSum } from './ecology.ts';
export { calcWeather } from './weather.ts';
export { hash32, rng, dice } from './rng.ts';
export { sha256Hex } from './sha256.ts';
export { round, clamp } from './math.ts';
export type * from './types.ts';
