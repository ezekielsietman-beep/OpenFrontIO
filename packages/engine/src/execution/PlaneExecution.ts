import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  zInt,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * A passenger flight between two airports. Planes ignore terrain and fly the
 * straight line from the source airport to the destination airport; both
 * airports' owners are paid when it lands.
 */
export class PlaneExecution implements Execution {
  private active = true;
  private mg: Game;
  private plane: Unit | undefined;
  private path: TileRef[] = [];
  private pathIndex = 0;
  private distance = 0;

  constructor(
    private origOwner: Player,
    private srcAirport: Unit,
    private dstAirport: Unit,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const line = straightLine(
      mg,
      this.srcAirport.tile(),
      this.dstAirport.tile(),
    );
    this.distance = line.length;
    this.path = sampleEvery(line, mg.config().planeSpeed());
  }

  tick(ticks: number): void {
    if (this.plane === undefined) {
      const spawn = this.origOwner.canBuild(
        UnitType.Plane,
        this.srcAirport.tile(),
      );
      if (spawn === false) {
        this.active = false;
        return;
      }
      this.plane = this.origOwner.buildUnit(UnitType.Plane, spawn, {
        targetUnit: this.dstAirport,
      });
      this.mg.recordMotionPlan({
        kind: "grid",
        unitId: this.plane.id(),
        planId: 1,
        startTick: ticks + 1,
        ticksPerStep: 1,
        path: this.path.slice(1),
      });
    }

    if (!this.plane.isActive()) {
      this.active = false;
      return;
    }

    // The flight is cancelled if either airport is lost or the two owners can
    // no longer do business (e.g. an embargo).
    const srcOwner = this.srcAirport.owner();
    const dstOwner = this.dstAirport.owner();
    if (
      !this.srcAirport.isActive() ||
      !this.dstAirport.isActive() ||
      srcOwner === dstOwner ||
      !srcOwner.canTrade(dstOwner)
    ) {
      this.plane.delete(false);
      this.active = false;
      return;
    }

    this.pathIndex++;
    if (this.pathIndex >= this.path.length) {
      this.land();
      return;
    }
    this.plane.move(this.path[this.pathIndex]);
  }

  private land() {
    this.active = false;
    this.plane!.delete(false);
    const src = this.srcAirport.owner();
    const dst = this.dstAirport.owner();
    const gold = this.mg.config().planeGold(this.distance, src);
    src.addGold(gold, this.srcAirport.tile());
    dst.addGold(gold, this.dstAirport.tile());
    src.addTradeGold(gold);
    dst.addTradeGold(gold);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return PlaneExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      plane: this.plane === undefined ? null : w.unit(this.plane),
      path: this.path,
      pathIndex: this.pathIndex,
      distance: this.distance,
      origOwner: w.player(this.origOwner),
      srcAirport: w.unit(this.srcAirport),
      dstAirport: w.unit(this.dstAirport),
    });
  }

  restoreSnapshot(s: PlaneExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.plane = s.plane === null ? undefined : r.unit(s.plane);
    this.path = s.path;
    this.pathIndex = s.pathIndex;
    this.distance = s.distance;
    this.origOwner = r.player(s.origOwner);
    this.srcAirport = r.unit(s.srcAirport);
    this.dstAirport = r.unit(s.dstAirport);
  }
}

/** Every `step`th tile of `path`, always keeping the final tile. */
function sampleEvery(path: TileRef[], step: number): TileRef[] {
  const out: TileRef[] = [];
  for (let i = 0; i < path.length; i += step) out.push(path[i]);
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Bresenham line from `from` to `to`, inclusive of both ends. Integer-only. */
export function straightLine(mg: Game, from: TileRef, to: TileRef): TileRef[] {
  let x0 = mg.x(from);
  let y0 = mg.y(from);
  const x1 = mg.x(to);
  const y1 = mg.y(to);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const out: TileRef[] = [];
  for (;;) {
    out.push(mg.ref(x0, y0));
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return out;
}

const PlaneExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  plane: zRef().nullable(),
  path: z.array(zTile()),
  pathIndex: zInt(),
  distance: zInt(),
  origOwner: zPlayerRef(),
  srcAirport: zRef(),
  dstAirport: zRef(),
});
type PlaneExecutionState = z.infer<typeof PlaneExecutionStateSchema>;

export const PlaneExecutionSnapshot = execSnapshotType({
  name: "Plane",
  version: 1,
  schema: PlaneExecutionStateSchema,
  cls: () => PlaneExecution,
});
