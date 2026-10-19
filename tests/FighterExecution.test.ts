import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { BomberExecution } from "@openfront/engine/execution/BomberExecution";
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

describe("Fighters", () => {
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

  test("needs a finished airport, and is capped per airport level", () => {
    const tile = game.ref(7, 10);
    player.conquer(tile);
    expect(player.canBuild(UnitType.Fighter, tile)).toBe(false);

    const airport = build(player, UnitType.Airport, 7, 10);
    expect(player.canBuild(UnitType.Fighter, tile)).toBe(airport.tile());

    const cap = game.config().maxFightersPerAirportLevel();
    for (let i = 0; i < cap; i++) {
      game.addExecution(new FighterExecution(player, tile));
      tick(2);
    }
    expect(player.units(UnitType.Fighter)).toHaveLength(cap);
    expect(player.canBuild(UnitType.Fighter, tile)).toBe(false);
    airport.increaseLevel();
    expect(player.canBuild(UnitType.Fighter, tile)).toBe(airport.tile());
  });

  test("an enemy fighter shoots a bomber down before it bombs", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    const enemyAirport = build(enemy, UnitType.Airport, 0, 3);
    game.config().bomberKillChancePerBomber = () => 1;
    game.config().fighterKillOdds = () => 1;

    game.addExecution(new FighterExecution(enemy, enemyAirport.tile()));
    tick(3);
    game.addExecution(new BomberExecution(player, city.tile(), 1));
    tick(60);
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(true);
  });

  test("without a fighter the same raid destroys the city", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberKillChancePerBomber = () => 1;
    game.addExecution(new BomberExecution(player, city.tile(), 1));
    tick(60);
    expect(city.isActive()).toBe(false);
  });

  test("a fighter never shoots its own side's bombers", () => {
    const airport = build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberKillChancePerBomber = () => 1;
    game.config().fighterKillOdds = () => 1;

    game.addExecution(new FighterExecution(player, airport.tile()));
    tick(3);
    game.addExecution(new BomberExecution(player, city.tile(), 1));
    tick(60);
    expect(city.isActive()).toBe(false);
    expect(player.units(UnitType.Fighter)).toHaveLength(1);
  });

  test("a fighter returns to its airport and parks after the threat", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    const enemyAirport = build(enemy, UnitType.Airport, 0, 3);
    game.config().fighterKillOdds = () => 1;

    game.addExecution(new FighterExecution(enemy, enemyAirport.tile()));
    tick(3);
    game.addExecution(new BomberExecution(player, city.tile(), 1));
    const fighter = enemy.units(UnitType.Fighter)[0];
    let leftTheAirport = false;
    for (let i = 0; i < 80; i++) {
      tick(1);
      if (fighter.tile() !== enemyAirport.tile()) leftTheAirport = true;
    }
    expect(leftTheAirport).toBe(true);
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(fighter.tile()).toBe(enemyAirport.tile());
  });

  test("a fighter whose airports are all lost is lost too", () => {
    const airport = build(player, UnitType.Airport, 7, 10);
    game.addExecution(new FighterExecution(player, airport.tile()));
    tick(3);
    expect(player.units(UnitType.Fighter)).toHaveLength(1);
    airport.delete(false);
    tick(3);
    expect(player.units(UnitType.Fighter)).toHaveLength(0);
  });
});
