import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Relation,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";

/** How much a nation wants to bomb each kind of structure. */
const BOMB_TARGET_WEIGHT: Partial<Record<UnitType, number>> = {
  [UnitType.MissileSilo]: 5,
  [UnitType.City]: 4,
  [UnitType.Airport]: 4,
  [UnitType.Factory]: 3,
  [UnitType.Port]: 2,
  [UnitType.SAMLauncher]: 2,
  [UnitType.DefensePost]: 1,
};

/** Fighters a nation wants per airport level, by difficulty (Easy: none). */
const FIGHTERS_PER_AIRPORT_LEVEL: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 1,
  [Difficulty.Hard]: 2,
  [Difficulty.Impossible]: 3,
};

/** 1-in-N chance per decision that a nation launches a bombing raid. */
const RAID_ODDS: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 10,
  [Difficulty.Hard]: 6,
  [Difficulty.Impossible]: 3,
};

/** 1-in-N chance per decision that a nation launches an air invasion. */
const INVASION_ODDS: Record<Difficulty, number> = {
  [Difficulty.Easy]: 0,
  [Difficulty.Medium]: 8,
  [Difficulty.Hard]: 5,
  [Difficulty.Impossible]: 3,
};

/** Only invade a target with fewer than this share of our troops. */
const INVASION_MAX_TARGET_TROOP_SHARE = 0.5;
/** Only invade while holding at least this share of our troop cap. */
const INVASION_MIN_OWN_TROOP_SHARE = 0.5;
/** Border tiles of the target sampled when picking a landing spot. */
const INVASION_TILE_SAMPLES = 25;

/**
 * What a nation does with its airports: stations fighters against enemy
 * bombers, raids hostile structures, and drops troops on weak hostile
 * neighbors. Stateless, so it needs no snapshot: every decision is derived
 * from the game state, with randomness from the nation's own PRNG.
 */
export class NationAirBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  /** One air decision per call, in priority order. */
  handleAir(): void {
    const difficulty = this.game.config().gameConfig().difficulty;
    if (difficulty === Difficulty.Easy) return;
    if (this.game.isSpawnImmunityActive()) return;
    const airports = this.finishedAirports(this.player);
    if (airports.length === 0) return;

    if (this.maybeBuildFighter(airports, difficulty)) return;
    if (this.maybeRaid(difficulty)) return;
    this.maybeInvade(airports, difficulty);
  }

  private finishedAirports(p: Player): Unit[] {
    return p
      .units(UnitType.Airport)
      .filter((a) => a.isActive() && !a.isUnderConstruction());
  }

  /** Players this nation considers fair targets: hostile, or a known traitor. */
  private hostiles(): Player[] {
    return this.game
      .players()
      .filter(
        (p) =>
          p !== this.player &&
          p.isAlive() &&
          !this.player.isFriendly(p) &&
          this.player.canAttackPlayer(p) &&
          (this.player.relation(p) <= Relation.Distrustful || p.isTraitor()),
      );
  }

  private maybeBuildFighter(airports: Unit[], difficulty: Difficulty): boolean {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.Fighter)) return false;

    // No point guarding the sky if nobody else can send bombers.
    const threatened = this.game
      .players()
      .some(
        (p) =>
          p !== this.player &&
          p.isAlive() &&
          !this.player.isFriendly(p) &&
          this.finishedAirports(p).length > 0,
      );
    if (!threatened) return false;

    const levels = airports.reduce((sum, a) => sum + a.level(), 0);
    const wanted = FIGHTERS_PER_AIRPORT_LEVEL[difficulty] * levels;
    if (this.player.units(UnitType.Fighter).length >= wanted) return false;

    // Keep a reserve so air units don't starve structures and nukes.
    const cost = this.game
      .unitInfo(UnitType.Fighter)
      .cost(this.game, this.player);
    if (this.player.gold() < cost * 2n) return false;

    const base = this.random.randElement(airports).tile();
    if (this.player.canBuild(UnitType.Fighter, base) === false) return false;
    this.game.addExecution(
      new ConstructionExecution(this.player, UnitType.Fighter, base),
    );
    return true;
  }

  private maybeRaid(difficulty: Difficulty): boolean {
    const config = this.game.config();
    if (config.isUnitDisabled(UnitType.Bomber)) return false;
    const odds = RAID_ODDS[difficulty];
    if (odds <= 0 || !this.random.chance(odds)) return false;

    const bomberCost = this.game
      .unitInfo(UnitType.Bomber)
      .cost(this.game, this.player);
    const squadron = BigInt(config.bomberSquadronSize());
    if (this.player.gold() < bomberCost * (squadron + 1n)) return false;

    const target = this.bestBombingTarget();
    if (target === null) return false;
    if (this.player.canBuild(UnitType.Bomber, target) === false) return false;
    this.game.addExecution(
      new ConstructionExecution(this.player, UnitType.Bomber, target),
    );
    return true;
  }

  /** The juiciest hostile structure, discounted by distance and nearby fighters. */
  private bestBombingTarget(): TileRef | null {
    const game = this.game;
    const airports = this.finishedAirports(this.player);
    const scramble = game.config().fighterScrambleRange();
    let best: TileRef | null = null;
    let bestScore = 0;
    for (const enemy of this.hostiles()) {
      const guards = enemy.units(UnitType.Fighter).filter((f) => f.isActive());
      for (const unit of enemy.units()) {
        const weight = BOMB_TARGET_WEIGHT[unit.type()];
        if (weight === undefined || !unit.isActive()) continue;
        let nearest = Infinity;
        for (const a of airports) {
          nearest = Math.min(
            nearest,
            game.manhattanDist(a.tile(), unit.tile()),
          );
        }
        const guarded = guards.filter(
          (f) =>
            game.euclideanDistSquared(f.tile(), unit.tile()) <=
            scramble * scramble,
        ).length;
        const score =
          (weight * unit.level()) / ((1 + nearest / 100) * (1 + 2 * guarded));
        if (score > bestScore) {
          bestScore = score;
          best = unit.tile();
        }
      }
    }
    return best;
  }

  private maybeInvade(airports: Unit[], difficulty: Difficulty): boolean {
    const game = this.game;
    const config = game.config();
    if (config.isUnitDisabled(UnitType.AirTransport)) return false;
    const odds = INVASION_ODDS[difficulty];
    if (odds <= 0 || !this.random.chance(odds)) return false;

    if (
      this.player.troops() <
      config.maxTroops(this.player) * INVASION_MIN_OWN_TROOP_SHARE
    ) {
      return false;
    }
    const cost = game.unitInfo(UnitType.AirTransport).cost(game, this.player);
    if (this.player.gold() < cost * 2n) return false;

    const weak = this.hostiles().filter(
      (p) =>
        p.troops() < this.player.troops() * INVASION_MAX_TARGET_TROOP_SHARE,
    );
    if (weak.length === 0) return false;
    const victim = this.random.randElement(weak);

    const border = [...victim.borderTiles()];
    if (border.length === 0) return false;
    let landing: TileRef | null = null;
    let landingDist = Infinity;
    for (let i = 0; i < Math.min(INVASION_TILE_SAMPLES, border.length); i++) {
      const t = this.random.randElement(border);
      for (const a of airports) {
        const d = game.manhattanDist(a.tile(), t);
        if (d < landingDist) {
          landingDist = d;
          landing = t;
        }
      }
    }
    if (landing === null) return false;
    if (this.player.canBuild(UnitType.AirTransport, landing) === false) {
      return false;
    }
    game.addExecution(
      new ConstructionExecution(this.player, UnitType.AirTransport, landing),
    );
    return true;
  }
}
