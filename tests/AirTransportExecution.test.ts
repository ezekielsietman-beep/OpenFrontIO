import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AirTransportExecution } from "@openfront/engine/execution/AirTransportExecution";
import { FighterExecution } from "@openfront/engine/execution/FighterExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let player: Player;
let enemy: Player;

function build(owner: Player, type: UnitType, x: number, y: number): Unit {
  owner.conquer(game.ref(x, y));
  const spawn = owner.canBuild(type, game.ref(x, y));
  if (spawn === false) throw new Error(`Unable to build ${type} for test`);
  return owner.buildUnit(type, spawn, {});
}

function tick(n: number) {
  for (let i = 0; i < n; i++) game.executeNextTick();
}

describe("Air transports", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    player = game.player("player_id");
    enemy = game.player("enemy_id");
    player.addGold(50_000_000n);
    enemy.addGold(50_000_000n);
    game.config().structureMinDist = () => 2;
  });

  test("needs a finished airport and a land tile that is not already ours", () => {
    const target = game.ref(1, 1);
    expect(player.canBuild(UnitType.AirTransport, target)).toBe(false);
    const airport = build(player, UnitType.Airport, 7, 10);
    expect(player.canBuild(UnitType.AirTransport, target)).toBe(airport.tile());
    // Own land is not a destination.
    player.conquer(game.ref(7, 11));
    expect(player.canBuild(UnitType.AirTransport, game.ref(7, 11))).toBe(false);
  });

  test("carries troops from the player and charges for the flight", () => {
    build(player, UnitType.Airport, 7, 10);
    const cost = game.unitInfo(UnitType.AirTransport).cost(game, player);
    const goldBefore = player.gold();
    const troopsBefore = player.troops();

    game.addExecution(new AirTransportExecution(player, game.ref(1, 1)));
    tick(2);
    const transport = player.units(UnitType.AirTransport)[0];
    expect(transport).toBeDefined();
    expect(transport.troops()).toBeGreaterThan(0);
    expect(goldBefore - player.gold()).toBe(cost);
    expect(player.troops()).toBeLessThan(troopsBefore);
  });

  test("lands on unowned land and claims it", () => {
    build(player, UnitType.Airport, 7, 10);
    const dst = game.ref(1, 1);
    expect(game.owner(dst).isPlayer()).toBe(false);

    game.addExecution(new AirTransportExecution(player, dst));
    tick(60);
    expect(player.units(UnitType.AirTransport)).toHaveLength(0);
    expect(game.owner(dst)).toBe(player);
  });

  test("lands on an enemy and attacks", () => {
    build(player, UnitType.Airport, 7, 10);
    const dst = game.ref(1, 1);
    enemy.conquer(dst);
    enemy.conquer(game.ref(1, 2));

    game.addExecution(new AirTransportExecution(player, dst));
    tick(60);
    expect(player.units(UnitType.AirTransport)).toHaveLength(0);
    expect(game.owner(dst)).toBe(player);
  });

  test("an enemy fighter shoots it down and the troops are lost", () => {
    build(player, UnitType.Airport, 7, 10);
    const dst = game.ref(1, 1);
    enemy.conquer(dst);
    const enemyAirport = build(enemy, UnitType.Airport, 0, 3);
    game.config().fighterKillOdds = () => 1;

    game.addExecution(new FighterExecution(enemy, enemyAirport.tile()));
    tick(3);
    game.addExecution(new AirTransportExecution(player, dst));
    tick(60);
    expect(player.units(UnitType.AirTransport)).toHaveLength(0);
    expect(game.owner(dst)).toBe(enemy);
  });

  test("is capped per airport level", () => {
    const airport = build(player, UnitType.Airport, 7, 10);
    const cap = game.config().maxAirTransportsPerAirportLevel();
    for (let i = 0; i < cap; i++) {
      game.addExecution(new AirTransportExecution(player, game.ref(1, 1 + i)));
      tick(2);
    }
    expect(player.units(UnitType.AirTransport)).toHaveLength(cap);
    expect(player.canBuild(UnitType.AirTransport, game.ref(3, 3))).toBe(false);
    airport.increaseLevel();
    expect(player.canBuild(UnitType.AirTransport, game.ref(3, 3))).not.toBe(
      false,
    );
  });
});
