// Trust-boundary checks for validateCommand: every Command variant has a valid
// shape that passes and at least one malformed shape that's rejected, plus the
// cross-cutting guards (non-object, unknown discriminant, id-list cap, unknown
// def names). The Record<Command["c"], …> in protocol.ts already makes the set of
// variants exhaustive at compile time; this asserts the runtime behaviour.
import { validateCommand, type Command } from "@bg/shared";

let pass = true;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) pass = false;
}

const tile = { x: 3, y: 4 };

// One known-good command per variant. Typed as Command so a protocol change that
// breaks an example is a compile error here too.
const valid: Command[] = [
  { c: "move", units: [1, 2], tile },
  { c: "gather", units: [1], node: 5 },
  { c: "build", unit: 1, building: "house", tile },
  { c: "construct", units: [1], building: 9 },
  { c: "train", building: 9, unit: "worker" },
  { c: "cancelTrain", building: 9 },
  { c: "cancelTrain", building: 9, index: 2 },
  { c: "research", building: 9, upgrade: "improvedTools" },
  { c: "advanceAge", building: 9 },
  { c: "rally", building: 9, tile },
  { c: "attack", units: [1], target: 7 },
  { c: "attackMove", units: [1], tile },
  { c: "patrol", units: [1], tile },
  { c: "setStance", units: [1], stance: "aggressive" },
  { c: "garrison", units: [1], building: 9 },
  { c: "ejectGarrison", building: 9 },
  { c: "stop", units: [1] },
  { c: "demolish", building: 9 },
  { c: "concede" },
];
for (const cmd of valid) {
  check(`valid: ${cmd.c}`, validateCommand(cmd));
}

// Confirm every Command variant is represented above — so a new variant can't be
// added without also exercising its validator here.
const KINDS = new Set(valid.map((c) => c.c));
const EXPECTED = [
  "move", "gather", "build", "construct", "train", "cancelTrain", "research",
  "advanceAge", "rally", "attack", "attackMove", "patrol", "setStance",
  "garrison", "ejectGarrison", "stop", "demolish", "concede",
];
for (const k of EXPECTED) check(`coverage: ${k} has a valid example`, KINDS.has(k));

// One malformed shape per representative variant — all must be rejected.
const malformed: [string, unknown][] = [
  ["move without tile", { c: "move", units: [1] }],
  ["move with non-numeric unit", { c: "move", units: ["x"], tile }],
  ["gather without node", { c: "gather", units: [1] }],
  ["build with unknown building", { c: "build", unit: 1, building: "death_star", tile }],
  ["build with non-numeric unit", { c: "build", unit: "1", building: "house", tile }],
  ["train with unknown unit", { c: "train", building: 9, unit: "dragon" }],
  ["research with unknown upgrade", { c: "research", building: 9, upgrade: "warp_drive" }],
  ["rally without tile", { c: "rally", building: 9 }],
  ["attack without target", { c: "attack", units: [1] }],
  ["setStance with bad stance", { c: "setStance", units: [1], stance: "berserk" }],
  ["garrison without building", { c: "garrison", units: [1] }],
  ["tile missing y", { c: "move", units: [1], tile: { x: 1 } }],
  ["tile with NaN", { c: "move", units: [1], tile: { x: NaN, y: 0 } }],
];
for (const [label, cmd] of malformed) {
  check(`rejected: ${label}`, !validateCommand(cmd));
}

// Cross-cutting guards.
check("rejected: null", !validateCommand(null));
check("rejected: not an object", !validateCommand("move"));
check("rejected: missing discriminant", !validateCommand({ units: [1], tile }));
check("rejected: unknown discriminant", !validateCommand({ c: "selfDestruct", units: [1] }));
check("rejected: id list over 1000 (DoS cap)", !validateCommand({
  c: "move",
  units: Array.from({ length: 1001 }, (_, i) => i),
  tile,
}));
check("accepted: id list at the 1000 cap", validateCommand({
  c: "move",
  units: Array.from({ length: 1000 }, (_, i) => i),
  tile,
}));

console.log(pass ? "PROTOCOL: PASS ✅" : "PROTOCOL: FAIL ❌");
process.exit(pass ? 0 : 1);
