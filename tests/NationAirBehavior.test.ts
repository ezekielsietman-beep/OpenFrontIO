import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { NationAirBehavior } from "@openfront/engine/execution/nation/NationAirBehavior";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

let game: Game;
let nation: Player;
let enemy: Player;
let behavior: NationAirBehavior;
let started: { type: UnitType; tile: number }[];

async function init(difficulty: Difficulty) {
  game = await setup(
    "half_land_half_ocean",
    { instantBuild: true, difficulty },
    [
      new PlayerInfo("nation", PlayerType.Human, null, "nation_id"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy_id"),
    ],
  );
  nation = game.player("nation_id");
  enemy = game.player("enemy_id");
  nation.addGold(50_000_000n);
  enemy.addGold(50_000_000n);
  game.config().structureMinDist = () => 2;
  behavior = new NationAirBehavior(new PseudoRandom(7), game, nation);
  started = [];
  const add = game.addExecution.bind(game);
  game.addExecution = (...execs) => {
    for (const e of execs) {
      if (e instanceof ConstructionExecution) {
        const c = e as unknown as { constructionType: UnitType; tile: number };
        started.push({ type: c.constructionType, tile: c.tile });
      }
    }
    return add(...execs);
  };
}

function build(owner: Player, type: UnitType, x: number, y: number): Unit {
  owner.conquer(game.ref(x, y));
  const spawn = owner.canBuild(type, game.ref(x, y));
  if (spawn === false) throw new Error(`Unable to build ${type} for test`);
  return owner.buildUnit(type, spawn, {});
}

/** Runs the decision until it acts or gives up. */
function decide(times = 40) {
  for (let i = 0; i < times && started.length === 0; i++) behavior.handleAir();
}

describe("NationAirBehavior", () => {
  test("Easy nations stay out of the air", async () => {
    await init(Difficulty.Easy);
    build(nation, UnitType.Airport, 7, 10);
    build(enemy, UnitType.Airport, 0, 3);
    decide();
    expect(started).toEqual([]);
  });

  test("a nation without a finished airport does nothing", async () => {
    await init(Difficulty.Impossible);
    build(enemy, UnitType.Airport, 0, 3);
    decide();
    expect(started).toEqual([]);
  });

  test("buys a fighter when another player has an airport", async () => {
    await init(Difficulty.Hard);
    const mine = build(nation, UnitType.Airport, 7, 10);
    build(enemy, UnitType.Airport, 0, 3);
    decide();
    expect(started).toEqual([{ type: UnitType.Fighter, tile: mine.tile() }]);
  });

  test("buys no fighter when nobody else can send bombers", async () => {
    await init(Difficulty.Hard);
    build(nation, UnitType.Airport, 7, 10);
    decide();
    expect(started.filter((s) => s.type === UnitType.Fighter)).toEqual([]);
  });

  test("stops buying fighters at its wanted number", async () => {
    await init(Difficulty.Medium); // 1 per airport level
    build(nation, UnitType.Airport, 7, 10);
    build(enemy, UnitType.Airport, 0, 3);
    decide();
    expect(started).toHaveLength(1);
    for (let i = 0; i < 5; i++) game.executeNextTick();
    expect(nation.units(UnitType.Fighter)).toHaveLength(1);
    started.length = 0;
    for (let i = 0; i < 40; i++) behavior.handleAir();
    expect(started.filter((s) => s.type === UnitType.Fighter)).toEqual([]);
  });

  test("raids a hostile player's structures", async () => {
    await init(Difficulty.Impossible);
    build(nation, UnitType.Airport, 7, 10);
    const city = build(enemy, UnitType.City, 1, 1);
    nation.updateRelation(enemy, -1000);
    // Fighters come first; fill the quota so the nation moves on to raiding.
    for (let i = 0; i < 12; i++) {
      game.addExecution(
        new ConstructionExecution(nation, UnitType.Fighter, game.ref(7, 10)),
      );
      game.executeNextTick();
    }
    started.length = 0;
    decide();
    expect(started).toEqual([{ type: UnitType.Bomber, tile: city.tile() }]);
  });

  test("never raids a friendly player", async () => {
    await init(Difficulty.Impossible);
    build(nation, UnitType.Airport, 7, 10);
    build(enemy, UnitType.City, 1, 1);
    nation.updateRelation(enemy, 1000);
    for (let i = 0; i < 40; i++) behavior.handleAir();
    expect(started.filter((s) => s.type === UnitType.Bomber)).toEqual([]);
  });

  test("invades a much weaker hostile player from the air", async () => {
    await init(Difficulty.Impossible);
    build(nation, UnitType.Airport, 7, 10);
    enemy.conquer(game.ref(1, 1));
    enemy.conquer(game.ref(1, 2));
    nation.updateRelation(enemy, -1000);
    nation.addTroops(1_000_000);
    enemy.removeTroops(enemy.troops());
    for (
      let i = 0;
      i < 40 && !started.some((s) => s.type === UnitType.AirTransport);
      i++
    ) {
      behavior.handleAir();
    }
    const landing = started.find((s) => s.type === UnitType.AirTransport);
    expect(landing).toBeDefined();
    expect(game.owner(landing!.tile)).toBe(enemy);
  });

  test("does not invade a player with comparable troops", async () => {
    await init(Difficulty.Impossible);
    build(nation, UnitType.Airport, 7, 10);
    enemy.conquer(game.ref(1, 1));
    nation.updateRelation(enemy, -1000);
    nation.addTroops(1_000_000);
    enemy.addTroops(1_000_000);
    for (let i = 0; i < 40; i++) behavior.handleAir();
    expect(started.filter((s) => s.type === UnitType.AirTransport)).toEqual([]);
  });
});
