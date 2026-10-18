import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zRandom,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { PlaneExecution } from "./PlaneExecution";

/**
 * Launches passenger flights from an airport to other players' airports.
 * Planes fly over any terrain, so unlike trade ships there is no
 * connected-water requirement.
 */
export class AirportExecution implements Execution {
  private active = true;
  private mg: Game;
  private airport: Unit;
  private random: PseudoRandom;
  private checkOffset: number;

  constructor(airport: Unit) {
    this.airport = airport;
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.random = new PseudoRandom(mg.ticks());
    this.checkOffset = mg.ticks() % 10;
  }

  tick(ticks: number): void {
    if (!this.airport.isActive()) {
      this.active = false;
      return;
    }
    if (this.airport.isUnderConstruction()) {
      return;
    }
    // Only check every 10 ticks for performance.
    if ((this.mg.ticks() + this.checkOffset) % 10 !== 0) {
      return;
    }

    const config = this.mg.config();
    const owner = this.airport.owner();
    const inFlight = this.mg
      .units(UnitType.Plane)
      .filter((p) => p.owner() === owner).length;
    const airportLevels = owner
      .units(UnitType.Airport)
      .reduce((sum, a) => sum + a.level(), 0);
    const cap = config.maxPlanesPerAirportLevel() * airportLevels;
    if (inFlight >= cap) return;

    let launch = false;
    for (let i = 0; i < this.airport.level(); i++) {
      if (this.random.chance(config.planeSpawnOdds())) {
        launch = true;
        break;
      }
    }
    if (!launch) return;

    const destinations = this.destinations();
    if (destinations.length === 0) return;
    const dst = this.random.randElement(destinations);
    this.mg.addExecution(new PlaneExecution(owner, this.airport, dst));
  }

  /** Other tradeable players' airports, nearer and higher-level ones likelier. */
  destinations(): Unit[] {
    const me = this.airport.owner();
    const airports = this.mg
      .players()
      .filter((p) => p !== me && p.canTrade(me))
      .flatMap((p) => p.units(UnitType.Airport))
      .filter((a) => a.isActive() && !a.isUnderConstruction())
      .sort(
        (a, b) =>
          this.mg.manhattanDist(this.airport.tile(), a.tile()) -
          this.mg.manhattanDist(this.airport.tile(), b.tile()),
      );
    const weighted: Unit[] = [];
    for (const a of airports) {
      for (let i = 0; i < a.level(); i++) weighted.push(a);
    }
    return weighted;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    const initialized = this.mg !== undefined;
    return AirportExecutionSnapshot.write({
      active: this.active,
      airport: w.unit(this.airport),
      init: initialized
        ? { random: w.random(this.random), checkOffset: this.checkOffset }
        : null,
    });
  }

  restoreSnapshot(s: AirportState, r: SnapshotReader): void {
    this.active = s.active;
    this.airport = r.unit(s.airport);
    if (s.init !== null) {
      this.mg = r.game;
      this.random = r.random(s.init.random);
      this.checkOffset = s.init.checkOffset;
    }
  }
}

const AirportStateSchema = z.object({
  active: z.boolean(),
  airport: zRef(),
  // Set by init.
  init: z.object({ random: zRandom(), checkOffset: zInt() }).nullable(),
});
type AirportState = z.infer<typeof AirportStateSchema>;

export const AirportExecutionSnapshot = execSnapshotType({
  name: "Airport",
  version: 1,
  schema: AirportStateSchema,
  cls: () => AirportExecution,
});
