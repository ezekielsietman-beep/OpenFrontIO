import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
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
import { sampleEvery, straightLine } from "./PlaneExecution";

type Leg = "out" | "back";

/** One bomber of the squadron and the straight-line leg it is flying. */
interface Flight {
  unit: Unit;
  /** Sideways offset (tiles) that keeps the squadron in formation. */
  lane: number;
  path: TileRef[];
  pathIndex: number;
  planId: number;
}

/**
 * Chance that a squadron of `bombers` destroys a structure: each bomber
 * independently has `perBomber` odds, so more bombers means better odds.
 */
export function raidKillChance(perBomber: number, bombers: number): number {
  let survive = 1;
  for (let i = 0; i < bombers; i++) survive *= 1 - perBomber;
  return 1 - survive;
}

/**
 * One bombing raid: a squadron launches from the nearest airport, flies the
 * straight line to the target, bombs it, then flies home. Enemy fighters can
 * shoot individual bombers down on either leg, which thins the squadron and
 * lowers the raid's odds. SAM launchers cannot touch them.
 */
export class BomberExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private flights: Flight[] = [];
  private launched = false;
  private srcAirport: Unit | undefined;
  private leg: Leg = "out";

  /** @param count bombers to send; 0 or less means the default squadron. */
  constructor(
    private owner: Player,
    private target: TileRef,
    private count: number = 0,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks() + this.target);
    if (this.count <= 0) this.count = mg.config().bomberSquadronSize();
  }

  tick(ticks: number): void {
    if (!this.launched) {
      this.launch(ticks);
      if (!this.active) return;
    }

    // Only fighters can bring a bomber down (see FighterExecution), which
    // deletes the unit, so just see who is still flying.
    const alive = this.flights.filter((f) => f.unit.isActive());
    if (alive.length === 0) {
      this.active = false;
      return;
    }

    if (this.leg === "out") {
      let arrived = false;
      for (const f of alive) {
        f.pathIndex++;
        if (f.pathIndex >= f.path.length) arrived = true;
        else f.unit.move(f.path[f.pathIndex]);
      }
      if (arrived) {
        this.bombTarget(alive.length);
        this.turnHome(ticks, alive);
      }
      return;
    }

    for (const f of alive) {
      f.pathIndex++;
      if (f.pathIndex >= f.path.length) f.unit.delete(false);
      else f.unit.move(f.path[f.pathIndex]);
    }
    if (alive.every((f) => !f.unit.isActive())) this.active = false;
  }

  private launch(ticks: number) {
    this.launched = true;
    const spawn = this.owner.canBuild(UnitType.Bomber, this.target);
    if (spawn === false) {
      this.active = false;
      return;
    }
    this.srcAirport =
      this.owner.units(UnitType.Airport).find((a) => a.tile() === spawn) ??
      undefined;
    // Buy as many as asked for, or as many as the player can afford.
    const units: Unit[] = [];
    for (let i = 0; i < this.count; i++) {
      if (
        i > 0 &&
        this.owner.canBuild(UnitType.Bomber, this.target) === false
      ) {
        break;
      }
      units.push(
        this.owner.buildUnit(UnitType.Bomber, spawn, {
          targetTile: this.target,
        }),
      );
    }
    units.forEach((unit, i) => {
      // Lanes sit 2 tiles apart and are centred on the straight line.
      const flight: Flight = {
        unit,
        lane: 2 * i - (units.length - 1),
        path: [],
        pathIndex: 0,
        planId: 0,
      };
      this.flights.push(flight);
      this.startLeg(ticks, flight, spawn, this.target);
    });
  }

  private startLeg(ticks: number, f: Flight, from: TileRef, to: TileRef) {
    const mg = this.mg;
    const [a, b] = this.shifted(from, to, f.lane);
    f.path = sampleEvery(straightLine(mg, a, b), mg.config().bomberSpeed());
    f.pathIndex = 0;
    f.planId++;
    mg.recordMotionPlan({
      kind: "grid",
      unitId: f.unit.id(),
      planId: f.planId,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path: f.path.slice(1),
    });
  }

  /** Both ends moved sideways by `lane` tiles, keeping the line parallel. */
  private shifted(
    from: TileRef,
    to: TileRef,
    lane: number,
  ): [TileRef, TileRef] {
    const mg = this.mg;
    const horizontal =
      Math.abs(mg.x(to) - mg.x(from)) >= Math.abs(mg.y(to) - mg.y(from));
    const move = (t: TileRef): TileRef => {
      const x = mg.x(t) + (horizontal ? 0 : lane);
      const y = mg.y(t) + (horizontal ? lane : 0);
      return mg.isValidCoord(x, y) ? mg.ref(x, y) : t;
    };
    return [move(from), move(to)];
  }

  private turnHome(ticks: number, alive: Flight[]) {
    const home = this.homeAirport(alive[0].unit.tile());
    if (home === null) {
      for (const f of alive) f.unit.delete(false);
      this.active = false;
      return;
    }
    this.leg = "back";
    this.srcAirport = home;
    for (const f of alive) {
      this.startLeg(ticks, f, f.unit.tile(), home.tile());
      // Step once now, like the first leg's spawn tick, so the plan lines up.
      f.pathIndex = 1;
      if (f.pathIndex >= f.path.length) f.unit.delete(false);
      else f.unit.move(f.path[f.pathIndex]);
    }
    if (alive.every((f) => !f.unit.isActive())) this.active = false;
  }

  /** The launch airport if it still stands, else the nearest other one. */
  private homeAirport(here: TileRef): Unit | null {
    const usable = (a: Unit) => a.isActive() && !a.isUnderConstruction();
    if (this.srcAirport !== undefined && usable(this.srcAirport)) {
      return this.srcAirport;
    }
    return findClosestBy(
      this.owner.units(UnitType.Airport),
      (a) => this.mg.manhattanDist(a.tile(), here),
      usable,
    );
  }

  private bombTarget(bombers: number) {
    const mg = this.mg;
    const config = mg.config();
    const radiusSq = config.bomberBlastRadius() ** 2;
    const killChance = raidKillChance(
      config.bomberKillChancePerBomber(),
      bombers,
    );
    const threshold = Math.round(killChance * 1000);
    const hostile = (victim: Player) =>
      victim !== this.owner && !this.owner.isFriendly(victim, true);

    const impacted = new Set<Player>();
    let destroyed = 0;
    for (const unit of mg.units()) {
      if (!unit.isActive() || !Structures.has(unit.type())) continue;
      if (mg.euclideanDistSquared(this.target, unit.tile()) > radiusSq)
        continue;
      const victim = unit.owner();
      if (!hostile(victim)) continue;
      impacted.add(victim);
      if (this.random.nextInt(0, 1000) < threshold) {
        unit.delete(true, this.owner);
        destroyed++;
      }
    }

    const centerOwner = mg.owner(this.target);
    if (centerOwner.isPlayer() && hostile(centerOwner)) {
      impacted.add(centerOwner);
    }

    const troopFraction = Math.min(
      0.25,
      config.bomberTroopKillFraction() * bombers,
    );
    for (const victim of impacted) {
      victim.removeTroops(victim.troops() * troopFraction);
      mg.displayMessage(
        "events_display.bomber_bombed",
        MessageType.UNIT_DESTROYED,
        victim.id(),
        undefined,
        { name: this.owner.displayName() },
        undefined,
        this.owner.id(),
      );
    }
    if (destroyed > 0) {
      mg.displayMessage(
        "events_display.bomber_raid_destroyed",
        MessageType.CAPTURED_ENEMY_UNIT,
        this.owner.id(),
        undefined,
        { count: String(destroyed) },
      );
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return BomberExecutionSnapshot.write({
      active: this.active,
      random: this.mg === undefined ? null : w.random(this.random),
      owner: w.player(this.owner),
      target: this.target,
      count: this.count,
      launched: this.launched,
      srcAirport:
        this.srcAirport === undefined ? null : w.unit(this.srcAirport),
      leg: this.leg,
      flights: this.flights.map((f) => ({
        unit: w.unit(f.unit),
        lane: f.lane,
        path: f.path,
        pathIndex: f.pathIndex,
        planId: f.planId,
      })),
    });
  }

  restoreSnapshot(s: BomberExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.random !== null) {
      this.mg = r.game;
      this.random = r.random(s.random);
    }
    this.owner = r.player(s.owner);
    this.target = s.target;
    this.count = s.count;
    this.launched = s.launched;
    this.srcAirport = s.srcAirport === null ? undefined : r.unit(s.srcAirport);
    this.leg = s.leg;
    this.flights = s.flights.map((f) => ({
      unit: r.unit(f.unit),
      lane: f.lane,
      path: f.path,
      pathIndex: f.pathIndex,
      planId: f.planId,
    }));
  }
}

const BomberExecutionStateSchema = z.object({
  active: z.boolean(),
  /** Null before init(). */
  random: zRandom().nullable(),
  owner: zPlayerRef(),
  target: zTile(),
  count: zInt(),
  launched: z.boolean(),
  srcAirport: zRef().nullable(),
  leg: z.enum(["out", "back"]),
  flights: z.array(
    z.object({
      unit: zRef(),
      lane: z.number().int(),
      path: z.array(zTile()),
      pathIndex: zInt(),
      planId: zInt(),
    }),
  ),
});
type BomberExecutionState = z.infer<typeof BomberExecutionStateSchema>;

export const BomberExecutionSnapshot = execSnapshotType({
  name: "Bomber",
  version: 1,
  schema: BomberExecutionStateSchema,
  cls: () => BomberExecution,
});
