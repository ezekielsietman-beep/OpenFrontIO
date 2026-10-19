import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BomberExecution,
  raidKillChance,
} from "@openfront/engine/execution/BomberExecution";
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
  // The bombers are created on the execution's first tick.
  for (let i = 0; i < 3; i++) game.executeNextTick();
  for (let i = 0; i < maxTicks && game.unitCount(UnitType.Bomber) > 0; i++) {
    game.executeNextTick();
  }
}

describe("raidKillChance", () => {
  test("more bombers means better odds", () => {
    const odds = [1, 2, 3, 4, 5].map((n) => raidKillChance(0.3, n));
    expect(odds[0]).toBeCloseTo(0.3);
    expect(odds[3]).toBeCloseTo(1 - 0.7 ** 4);
    for (let i = 1; i < odds.length; i++) {
      expect(odds[i]).toBeGreaterThan(odds[i - 1]);
    }
    expect(odds[4]).toBeLessThan(1);
  });

  test("the default odds make a squadron very likely to hit", () => {
    const perBomber = 0.4;
    expect(raidKillChance(perBomber, 1)).toBeCloseTo(0.4);
    expect(raidKillChance(perBomber, 4)).toBeGreaterThan(0.85);
  });
});

describe("Bombers", () => {
  beforeEach(async () => {
    game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("player", PlayerType.Human, null, "player_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ]);
    player = game.player("player_id");
    enemy = game.player("enemy_id");
    player.addGold(50_000_000n);
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

  test("an order sends a squadron and charges for each bomber", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    const cost = game.unitInfo(UnitType.Bomber).cost(game, player);
    const before = player.gold();

    game.addExecution(new BomberExecution(player, city.tile()));
    game.executeNextTick();
    game.executeNextTick();
    const size = game.config().bomberSquadronSize();
    // The shipped balance: a squadron costs less than an atom bomb.
    expect(cost * BigInt(size)).toBeLessThan(
      game.unitInfo(UnitType.AtomBomb).cost(game, player),
    );
    expect(game.config().bomberKillChancePerBomber()).toBe(0.4);
    expect(game.unitCount(UnitType.Bomber)).toBe(size);
    expect(before - player.gold()).toBe(cost * BigInt(size));
  });

  test("an explicit count overrides the squadron size", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    game.addExecution(new BomberExecution(player, city.tile(), 2));
    game.executeNextTick();
    game.executeNextTick();
    expect(game.unitCount(UnitType.Bomber)).toBe(2);
  });

  test("sends only as many bombers as the player can afford", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    const cost = game.unitInfo(UnitType.Bomber).cost(game, player);
    player.removeGold(player.gold());
    player.addGold(cost * 2n + cost / 2n);

    game.addExecution(new BomberExecution(player, city.tile(), 4));
    game.executeNextTick();
    game.executeNextTick();
    expect(game.unitCount(UnitType.Bomber)).toBe(2);
  });

  test("a successful raid destroys the city, then the squadron returns", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    city.increaseLevel();
    game.config().bomberKillChancePerBomber = () => 1;
    const troopsBefore = enemy.troops();

    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(false);
    expect(enemy.troops()).toBeLessThan(troopsBefore);
  });

  test("a failed raid leaves the city standing", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberKillChancePerBomber = () => 0;

    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(true);
  });

  test("friendly structures are not harmed", () => {
    build(player, UnitType.Airport, 7, 10);
    const mine = build(player, UnitType.City, 7, 14);
    const city = build(enemy, UnitType.City, 1, 1);
    game.config().bomberBlastRadius = () => 100;
    game.config().bomberKillChancePerBomber = () => 1;
    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(mine.isActive()).toBe(true);
    expect(city.isActive()).toBe(false);
  });

  test("SAM launchers cannot shoot bombers down", () => {
    build(player, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    build(enemy, UnitType.SAMLauncher, 3, 3);
    game.config().bomberKillChancePerBomber = () => 1;

    game.addExecution(new BomberExecution(player, city.tile()));
    runUntilGone();
    expect(game.unitCount(UnitType.Bomber)).toBe(0);
    expect(city.isActive()).toBe(false);
  });
});
