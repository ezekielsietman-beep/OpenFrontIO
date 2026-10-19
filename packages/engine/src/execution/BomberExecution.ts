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

/**
 * One bombing sortie: launch from the nearest airport, fly the straight line
 * to the target, bomb it, then fly home. Enemy SAM launchers can shoot the
 * bomber down on either leg.
 */
export class BomberExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private bomber: Unit | undefined;
  private srcAirport: Unit | undefined;
  private leg: Leg = "out";
  private path: TileRef[] = [];
  private pathIndex = 0;
  private planId = 0;

  constructor(
    private owner: Player,
    private target: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks() + this.target);
  }

  tick(ticks: number): void {
    if (this.bomber === undefined) {
      const spawn = this.owner.canBuild(UnitType.Bomber, this.target);
      if (spawn === false) {
        this.active = false;
        return;
      }
      this.srcAirport =
        this.owner.units(UnitType.Airport).find((a) => a.tile() === spawn) ??
        undefined;
      this.bomber = this.owner.buildUnit(UnitType.Bomber, spawn, {
        targetTile: this.target,
      });
      this.startLeg(ticks, spawn, this.target);
    }

    if (!this.bomber.isActive()) {
      this.active = false;
      return;
    }

    if (this.shotDown()) {
      return;
    }

    this.pathIndex++;
    if (this.pathIndex >= this.path.length) {
      this.arrive(ticks);
      return;
    }
    this.bomber.move(this.path[this.pathIndex]);
  }

  private startLeg(ticks: number, from: TileRef, to: TileRef) {
    const line = straightLine(this.mg, from, to);
    this.path = sampleEvery(line, this.mg.config().bomberSpeed());
    this.pathIndex = 0;
    this.planId++;
    this.mg.recordMotionPlan({
      kind: "grid",
      unitId: this.bomber!.id(),
      planId: this.planId,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path: this.path.slice(1),
    });
  }

  private arrive(ticks: number) {
    if (this.leg === "out") {
      this.bombTarget();
      const home = this.homeAirport();
      if (home === null) {
        this.bomber!.delete(false);
        this.active = false;
        return;
      }
      this.leg = "back";
      this.srcAirport = home;
      this.startLeg(ticks, this.bomber!.tile(), home.tile());
      // The unit stays on the target tile this tick, like the first leg's
      // spawn tick; step it once so the motion plan lines up.
      this.pathIndex = 1;
      if (this.pathIndex >= this.path.length) {
        this.bomber!.delete(false);
        this.active = false;
        return;
      }
      this.bomber!.move(this.path[this.pathIndex]);
      return;
    }
    // Landed.
    this.bomber!.delete(false);
    this.active = false;
  }

  /** The launch airport if it still stands, else the nearest other one. */
  private homeAirport(): Unit | null {
    const usable = (a: Unit) => a.isActive() && !a.isUnderConstruction();
    if (this.srcAirport !== undefined && usable(this.srcAirport)) {
      return this.srcAirport;
    }
    const here = this.bomber!.tile();
    return findClosestBy(
      this.owner.units(UnitType.Airport),
      (a) => this.mg.manhattanDist(a.tile(), here),
      usable,
    );
  }

  private shotDown(): boolean {
    const mg = this.mg;
    const config = mg.config();
    const here = this.bomber!.tile();
    for (const sam of mg.units(UnitType.SAMLauncher)) {
      if (!sam.isActive() || sam.isUnderConstruction()) continue;
      const samOwner = sam.owner();
      if (samOwner === this.owner || this.owner.isFriendly(samOwner)) continue;
      const range = config.samRange(sam.level());
      if (mg.euclideanDistSquared(sam.tile(), here) > range * range) continue;
      for (let i = 0; i < sam.level(); i++) {
        if (this.random.chance(config.bomberSamKillOdds())) {
          mg.displayMessage(
            "events_display.bomber_shot_down",
            MessageType.SAM_HIT,
            samOwner.id(),
            undefined,
            { name: this.owner.displayName() },
          );
          this.bomber!.delete(true, samOwner);
          this.active = false;
          return true;
        }
      }
    }
    return false;
  }

  private bombTarget() {
    const mg = this.mg;
    const config = mg.config();
    const radius = config.bomberBlastRadius();
    const radiusSq = radius * radius;
    const impacted = new Set<Player>();

    for (const unit of mg.units()) {
      if (!unit.isActive()) continue;
      if (!Structures.has(unit.type())) continue;
      if (mg.euclideanDistSquared(this.target, unit.tile()) > radiusSq)
        continue;
      const victim = unit.owner();
      if (victim === this.owner || this.owner.isFriendly(victim, true))
        continue;
      impacted.add(victim);
      unit.decreaseLevel(this.owner);
    }

    const centerOwner = mg.owner(this.target);
    if (centerOwner.isPlayer()) impacted.add(centerOwner);

    for (const victim of impacted) {
      if (victim === this.owner || this.owner.isFriendly(victim, true))
        continue;
      victim.removeTroops(victim.troops() * config.bomberTroopKillFraction());
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
      bomber: this.bomber === undefined ? null : w.unit(this.bomber),
      srcAirport:
        this.srcAirport === undefined ? null : w.unit(this.srcAirport),
      leg: this.leg,
      path: this.path,
      pathIndex: this.pathIndex,
      planId: this.planId,
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
    this.bomber = s.bomber === null ? undefined : r.unit(s.bomber);
    this.srcAirport = s.srcAirport === null ? undefined : r.unit(s.srcAirport);
    this.leg = s.leg;
    this.path = s.path;
    this.pathIndex = s.pathIndex;
    this.planId = s.planId;
  }
}

const BomberExecutionStateSchema = z.object({
  active: z.boolean(),
  /** Null before init(). */
  random: zRandom().nullable(),
  owner: zPlayerRef(),
  target: zTile(),
  bomber: zRef().nullable(),
  srcAirport: zRef().nullable(),
  leg: z.enum(["out", "back"]),
  path: z.array(zTile()),
  pathIndex: zInt(),
  planId: zInt(),
});
type BomberExecutionState = z.infer<typeof BomberExecutionStateSchema>;

export const BomberExecutionSnapshot = execSnapshotType({
  name: "Bomber",
  version: 1,
  schema: BomberExecutionStateSchema,
  cls: () => BomberExecution,
});
