import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { BomberExecution } from "@openfront/engine/execution/BomberExecution";
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

function runUntilGone(maxTicks = 400) {
  // The bomber is created on the execution's first tick.
  for (let i = 0; i < 3; i++) game.executeNextTick();
  for (let i = 0; i < maxTicks && game.unitCount(UnitType.Bomber) > 0; i++) {
    game.executeNextTick();
  }
}

describe("Bombers", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    player = game.player("player_id");
    enemy = game.player("enemy_id");
    player.addGold(5_000_000n);
    enemy.addGold(5_000_000n);
    game.config().structureMinDist = () => 2;
  });

  test("needs a finished airport and an enemy-owned target", () => {
    const target = game.ref(0, 0);
    enemy.conquer(target);
    expect(player.canBuild(UnitType.Bomber, target)).toBe(false);

    build(player, UnitType.Airport, 7, 10);
    expect(player.canBuild(UnitType.Bomber, target)).not.toBe(false);
    // Own territory and unowned land are not valid targets.
    expect(player.canBuild(UnitType.Bomber, game.ref(7, 11))).toBe(false);
    expect(player.canBuild(UnitType.Bomber, game.ref(4, 14))).toBe(false);
  });

  test("a sortie costs gold, damages the target, then returns and lands", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    city.increaseLevel();
    const troopsBefore = enemy.troops();
    const goldBefore = player.gold();

    game.addExecution(new BomberExecution(player, city.tile()));
    game.executeNextTick();
    game.executeNextTick();
    expect(game.unitCount(UnitType.Bomber)).toBe(1);
    expect(player.gold()).toBeLessThan(goldBefore);

    runUntilGone();
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(true);
    expect(city.level()).toBe(1);
    expect(enemy.troops()).toBeLessThan(troopsBefore);
  });

  test("a level 1 structure is destroyed by a hit", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(city.isActive()).toBe(false);
  });

  test("friendly structures are not harmed", () => {
    build(player, UnitType.Airport, 7, 10);
    const mine = build(player, UnitType.City, 7, 14);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberBlastRadius = () => 100;
    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(mine.isActive()).toBe(true);
    expect(city.isActive()).toBe(false);
  });

  test("an enemy SAM in range shoots the bomber down before it bombs", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    build(enemy, UnitType.SAMLauncher, 3, 3);
    game.config().bomberSamKillOdds = () => 1;

    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(true);
  });

  test("a SAM does not stop its owner's allies' bombers (own SAM ignored)", () => {
    build(player, UnitType.Airport, 7, 10);
    build(player, UnitType.SAMLauncher, 7, 14);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberSamKillOdds = () => 1;
    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(city.isActive()).toBe(false);
  });
});
