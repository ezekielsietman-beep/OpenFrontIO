import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zPlayerRef,
  zRandom,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { findClosestBy } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A fighter based at an airport. It sits parked until an enemy bomber or air
 * transport comes within scramble range, chases it at higher speed than they
 * fly, shoots it down when close, then returns and parks. It is the only
 * thing that can stop a bomber. If the owner loses every airport the fighter is lost.
 */
export class FighterExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private fighter: Unit | undefined;
  private home: Unit | undefined;
  private target: Unit | undefined;

  constructor(
    private owner: Player,
    private tile: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks() + this.tile);
  }

  tick(ticks: number): void {
    if (this.fighter === undefined) {
      const spawn = this.owner.canBuild(UnitType.Fighter, this.tile);
      if (spawn === false) {
        this.active = false;
        return;
      }
      this.home =
        this.owner.units(UnitType.Airport).find((a) => a.tile() === spawn) ??
        undefined;
      this.fighter = this.owner.buildUnit(UnitType.Fighter, spawn, {});
    }

    if (!this.fighter.isActive()) {
      this.active = false;
      return;
    }

    // Rebase if the home airport was lost; with no airport left it crashes.
    if (this.home === undefined || !this.home.isActive()) {
      this.home = this.nearestAirport() ?? undefined;
      if (this.home === undefined) {
        this.fighter.delete(false);
        this.active = false;
        return;
      }
    }

    this.target = this.pickTarget();
    if (this.target !== undefined) {
      this.engage(this.target);
      return;
    }
    this.returnHome();
  }

  private nearestAirport(): Unit | null {
    const here = this.fighter!.tile();
    return findClosestBy(
      this.owner.units(UnitType.Airport),
      (a) => this.mg.manhattanDist(a.tile(), here),
      (a) => a.isActive() && !a.isUnderConstruction(),
    );
  }

  /** Keep chasing the current target while it stays in reach, else pick the nearest threat. */
  private pickTarget(): Unit | undefined {
    const mg = this.mg;
    const range = mg.config().fighterScrambleRange();
    const homeTile = this.home!.tile();
    const hostile = (b: Unit) =>
      b.isActive() &&
      b.owner() !== this.owner &&
      !this.owner.isFriendly(b.owner());
    const inReach = (b: Unit, r: number) =>
      mg.euclideanDistSquared(homeTile, b.tile()) <= r * r;

    // Hysteresis: a fighter already in pursuit follows its target further out.
    if (
      this.target !== undefined &&
      hostile(this.target) &&
      inReach(this.target, range * 1.5)
    ) {
      return this.target;
    }
    const here = this.fighter!.tile();
    return (
      findClosestBy(
        mg.units(UnitType.Bomber, UnitType.AirTransport),
        (b) => mg.euclideanDistSquared(here, b.tile()),
        (b) => hostile(b) && inReach(b, range),
      ) ?? undefined
    );
  }

  private engage(target: Unit) {
    const mg = this.mg;
    const config = mg.config();
    const killRange = config.fighterKillRange();
    const here = this.fighter!.tile();
    if (mg.euclideanDistSquared(here, target.tile()) <= killRange * killRange) {
      if (this.random.chance(config.fighterKillOdds())) {
        const victim = target.owner();
        const isTransport = target.type() === UnitType.AirTransport;
        mg.displayMessage(
          isTransport
            ? "events_display.air_transport_intercepted"
            : "events_display.bomber_intercepted",
          MessageType.UNIT_DESTROYED,
          victim.id(),
          undefined,
          { name: this.owner.displayName() },
          undefined,
          this.owner.id(),
        );
        mg.displayMessage(
          isTransport
            ? "events_display.fighter_shot_down_air_transport"
            : "events_display.fighter_shot_down_bomber",
          MessageType.CAPTURED_ENEMY_UNIT,
          this.owner.id(),
          undefined,
          { name: victim.displayName() },
        );
        target.delete(true, this.owner);
        this.target = undefined;
        return;
      }
    }
    this.fighter!.move(this.stepToward(here, target.tile()));
  }

  private returnHome() {
    const here = this.fighter!.tile();
    const home = this.home!.tile();
    if (here !== home) this.fighter!.move(this.stepToward(here, home));
  }

  /** Up to `fighterSpeed` single-tile steps toward `to`, over any terrain. */
  private stepToward(from: TileRef, to: TileRef): TileRef {
    const mg = this.mg;
    let x = mg.x(from);
    let y = mg.y(from);
    const tx = mg.x(to);
    const ty = mg.y(to);
    for (let i = 0; i < mg.config().fighterSpeed(); i++) {
      if (x === tx && y === ty) break;
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
    }
    return mg.ref(x, y);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return FighterExecutionSnapshot.write({
      active: this.active,
      random: this.mg === undefined ? null : w.random(this.random),
      owner: w.player(this.owner),
      tile: this.tile,
      fighter: this.fighter === undefined ? null : w.unit(this.fighter),
      home: this.home === undefined ? null : w.unit(this.home),
      target: this.target === undefined ? null : w.unit(this.target),
    });
  }

  restoreSnapshot(s: FighterExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.random !== null) {
      this.mg = r.game;
      this.random = r.random(s.random);
    }
    this.owner = r.player(s.owner);
    this.tile = s.tile;
    this.fighter = s.fighter === null ? undefined : r.unit(s.fighter);
    this.home = s.home === null ? undefined : r.unit(s.home);
    this.target = s.target === null ? undefined : r.unit(s.target);
  }
}

const FighterExecutionStateSchema = z.object({
  active: z.boolean(),
  /** Null before init(). */
  random: zRandom().nullable(),
  owner: zPlayerRef(),
  tile: zTile(),
  fighter: zRef().nullable(),
  home: zRef().nullable(),
  target: zRef().nullable(),
});
type FighterExecutionState = z.infer<typeof FighterExecutionStateSchema>;

export const FighterExecutionSnapshot = execSnapshotType({
  name: "Fighter",
  version: 1,
  schema: FighterExecutionStateSchema,
  cls: () => FighterExecution,
});
