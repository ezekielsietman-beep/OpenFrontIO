import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
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
import { AttackExecution } from "./AttackExecution";
import { sampleEvery, straightLine } from "./PlaneExecution";

/**
 * Flies troops from the nearest airport to a land tile, over any terrain, and
 * lands them: they attack the owner of the tile, take unowned land, or
 * reinforce a friendly owner. Fighters can shoot it down, which loses the
 * troops on board.
 */
export class AirTransportExecution implements Execution {
  private active = true;
  private mg: Game;
  private transport: Unit | undefined;
  private path: TileRef[] = [];
  private pathIndex = 0;

  constructor(
    private owner: Player,
    private dst: TileRef,
  ) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (this.transport === undefined) {
      this.launch(ticks);
      if (!this.active) return;
    }
    const transport = this.transport!;
    if (!transport.isActive()) {
      this.active = false;
      return;
    }
    this.pathIndex++;
    if (this.pathIndex >= this.path.length) {
      this.land();
      return;
    }
    transport.move(this.path[this.pathIndex]);
  }

  private launch(ticks: number) {
    const mg = this.mg;
    const spawn = this.owner.canBuild(UnitType.AirTransport, this.dst);
    if (spawn === false) {
      this.active = false;
      return;
    }
    const target = mg.owner(this.dst);
    const troops = Math.min(
      mg.config().boatAttackAmount(this.owner, target),
      this.owner.troops(),
    );
    this.transport = this.owner.buildUnit(UnitType.AirTransport, spawn, {
      troops,
      targetTile: this.dst,
    });
    this.path = sampleEvery(
      straightLine(mg, spawn, this.dst),
      mg.config().airTransportSpeed(),
    );
    mg.recordMotionPlan({
      kind: "grid",
      unitId: this.transport.id(),
      planId: 1,
      startTick: ticks + 1,
      ticksPerStep: 1,
      path: this.path.slice(1),
    });
    if (target.isPlayer()) {
      mg.displayIncomingUnit(
        this.transport.id(),
        "events_display.air_invasion_inbound",
        MessageType.NAVAL_INVASION_INBOUND,
        target.id(),
      );
    }
  }

  private land() {
    const mg = this.mg;
    const transport = this.transport!;
    const troops = transport.troops();
    const target = mg.owner(this.dst);
    this.active = false;
    transport.delete(false);

    // The tile changed hands in flight and is ours now: bring the troops home.
    if (target === this.owner) {
      this.owner.addTroops(troops);
      return;
    }
    this.owner.conquer(this.dst);
    if (target.isPlayer() && this.owner.isFriendly(target)) {
      this.owner.addTroops(troops);
      return;
    }
    mg.addExecution(
      new AttackExecution(troops, this.owner, target.id(), this.dst, false),
    );
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirTransportExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      owner: w.player(this.owner),
      dst: this.dst,
      transport: this.transport === undefined ? null : w.unit(this.transport),
      path: this.path,
      pathIndex: this.pathIndex,
    });
  }

  restoreSnapshot(s: AirTransportExecutionState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.owner = r.player(s.owner);
    this.dst = s.dst;
    this.transport = s.transport === null ? undefined : r.unit(s.transport);
    this.path = s.path;
    this.pathIndex = s.pathIndex;
  }
}

const AirTransportExecutionStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  owner: zPlayerRef(),
  dst: zTile(),
  transport: zRef().nullable(),
  path: z.array(zTile()),
  pathIndex: zInt(),
});
type AirTransportExecutionState = z.infer<
  typeof AirTransportExecutionStateSchema
>;

export const AirTransportExecutionSnapshot = execSnapshotType({
  name: "AirTransport",
  version: 1,
  schema: AirTransportExecutionStateSchema,
  cls: () => AirTransportExecution,
});
