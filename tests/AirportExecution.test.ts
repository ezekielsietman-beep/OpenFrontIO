import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AirportExecution } from "@openfront/engine/execution/AirportExecution";
import {
  PlaneExecution,
  straightLine,
} from "@openfront/engine/execution/PlaneExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let other: Player;

function buildAirport(owner: Player, x: number, y: number): Unit {
  owner.conquer(game.ref(x, y));
  const spawn = owner.canBuild(UnitType.Airport, game.ref(x, y));
  if (spawn === false) throw new Error("Unable to build airport for test");
  return owner.buildUnit(UnitType.Airport, spawn, {});
}

describe("Airports and planes", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("other", PlayerType.Human, null, "other_id"),
    ]);
    player = game.player("player_id");
    player.addGold(1_000_000n);
    other = game.player("other_id");
    other.addGold(1_000_000n);
    game.config().structureMinDist = () => 10;
  });

  test("airport can be built on land", () => {
    const airport = buildAirport(player, 7, 10);
    expect(airport.type()).toBe(UnitType.Airport);
    expect(player.units(UnitType.Airport)).toHaveLength(1);
  });

  test("straightLine includes both endpoints and is contiguous", () => {
    const a = game.ref(2, 3);
    const b = game.ref(12, 9);
    const line = straightLine(game, a, b);
    expect(line[0]).toBe(a);
    expect(line[line.length - 1]).toBe(b);
    for (let i = 1; i < line.length; i++) {
      const dx = Math.abs(game.x(line[i]) - game.x(line[i - 1]));
      const dy = Math.abs(game.y(line[i]) - game.y(line[i - 1]));
      expect(Math.max(dx, dy)).toBe(1);
    }
  });

  test("destinations are only other players' airports, weighted by level", () => {
    const mine = buildAirport(player, 7, 10);
    const execution = new AirportExecution(mine);
    execution.init(game, 0);
    game.config().structureMinDist = () => 2;
    buildAirport(player, 7, 14); // own second airport is never a destination
    const theirs = buildAirport(other, 0, 0);
    theirs.increaseLevel();
    expect(execution.destinations()).toEqual([theirs, theirs]);
  });

  test("a completed flight pays both owners and removes the plane", () => {
    const src = buildAirport(player, 7, 10);
    const dst = buildAirport(other, 0, 0);
    const before = [player.gold(), other.gold()];

    game.addExecution(new PlaneExecution(player, src, dst));
    for (let i = 0; i < 200 && game.unitCount(UnitType.Plane) + i < 3; i++) {
      game.executeNextTick();
    }
    expect(game.unitCount(UnitType.Plane)).toBe(1);
    for (let i = 0; i < 200 && game.unitCount(UnitType.Plane) > 0; i++) {
      game.executeNextTick();
    }
    expect(game.unitCount(UnitType.Plane)).toBe(0);
    expect(player.gold()).toBeGreaterThan(before[0]);
    expect(other.gold()).toBeGreaterThan(before[1]);
  });

  test("a flight is cancelled without payout if the destination is lost", () => {
    const src = buildAirport(player, 7, 10);
    const dst = buildAirport(other, 0, 0);
    const before = player.gold();
    game.addExecution(new PlaneExecution(player, src, dst));
    game.executeNextTick();
    game.executeNextTick();
    dst.delete(false);
    for (let i = 0; i < 20; i++) game.executeNextTick();
    expect(game.unitCount(UnitType.Plane)).toBe(0);
    expect(player.gold()).toBe(before);
  });
});
