// Self-check: run with `node selfcheck.ts` (node >= 23.6 strips types natively).
import { readFile } from "node:fs/promises"
import { strict as assert } from "node:assert"
import { parseModelList, loadPool, makePicker, type ModelRef } from "./index.ts"

// 1. Parser on the real list file.
const md = await readFile("/home/orca/src/opencode_free_models.md", "utf8")
const parsed = parseModelList(md)
assert.equal(parsed.length, 10, `expected 10 unique models, got ${parsed.length}`)
assert.deepEqual(
  parsed.map((m) => `${m.providerID}/${m.id}`),
  [
    "opencode/beam-free",
    "opencode/big-pickle",
    "opencode/deepseek-v4.1-flash-free",
    "opencode/glm-5.3-flash-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3.5-super-vl-free",
    "opencode/space-bunny-free",
  ],
)

// 2. Exclusion (nemotron-3.5-lightning-free must be out of the pool).
const { pool, source } = await loadPool("/home/orca/src/opencode_free_models.md", new Set(["nemotron-3.5-lightning-free"]))
assert.equal(source, "/home/orca/src/opencode_free_models.md")
assert.equal(pool.length, 9, `expected 9 after exclusion, got ${pool.length}`)
assert.ok(!pool.some((m) => m.id === "nemotron-3.5-lightning-free"))

// 3. Fallback pool when the file is missing.
const fb = await loadPool("/nonexistent/path.md", new Set(["nemotron-3.5-lightning-free"]))
assert.equal(fb.source, "builtin-fallback")
assert.equal(fb.pool.length, 9)

// 4. Round-robin: circle order is a,b,c,d; b is cooling.
const four: ModelRef[] = [
  { providerID: "opencode", id: "a" },
  { providerID: "opencode", id: "b" },
  { providerID: "opencode", id: "c" },
  { providerID: "opencode", id: "d" },
]
const dropped = new Map<string, number>([["b", Date.now()]])

// Strict pass: b is skipped, the rest are taken in circle order.
const pick = makePicker(() => four)
assert.equal(pick(undefined, dropped, 10 * 60_000)?.id, "a")
assert.equal(pick(undefined, dropped, 10 * 60_000)?.id, "c")
assert.equal(pick(undefined, dropped, 10 * 60_000)?.id, "d")

// Never returns the current model.
const pick2 = makePicker(() => four)
assert.equal(pick2("a", dropped, 10 * 60_000)?.id, "c")

// Loose pass (everything cooling): still rotates instead of returning nothing.
const pick3 = makePicker(() => four)
const allCool = new Map<string, number>(four.map((m) => [m.id, Date.now()]))
assert.equal(pick3(undefined, allCool, 10 * 60_000)?.id, "a")

// 5. Error classification.
import { classifyError } from "./index.ts"
assert.equal(classifyError({ status: 429 }), "rate")
assert.equal(classifyError({ type: "AI.Error.RateLimit", message: "Upstream request failed: Endpoint is unavailable." }), "rate")
assert.equal(classifyError({ message: "quota exhausted for today" }), "rate")
assert.equal(classifyError({ type: "AI.Error.Authentication", status: 403, message: "This model is not available in your country" }), "unusable")
assert.equal(classifyError({ message: "Request timed out after 25s" }), "unusable")
assert.equal(classifyError({ status: 502, message: "Bad gateway" }), "unusable")
assert.equal(classifyError({ message: "Prompt is too long: 210000 tokens > 200000 maximum" }), undefined)
assert.equal(classifyError(undefined), undefined)

// 5. Order: models in the `last` set go to the end of the queue.
const { pool: poolOrdered } = await loadPool(
  "/home/orca/src/opencode_free_models.md",
  new Set(["nemotron-3.5-lightning-free"]),
  new Set(["nemotron-3.5-super-vl-free"]),
)
assert.deepEqual(
  poolOrdered.map((m) => m.id),
  [
    "beam-free",
    "big-pickle",
    "deepseek-v4.1-flash-free",
    "glm-5.3-flash-free",
    "longcat-2.5-preview-free",
    "mimo-v2.6-flash-free",
    "nemotron-3-ultra-free",
    "space-bunny-free",
    "nemotron-3.5-super-vl-free",
  ],
)

// 6. Registry validation: known set keeps existing models, drops the rest;
//    an empty registry (not ready) skips filtering.
import { filterKnown } from "./index.ts"
const reg = new Set([
  "opencode/a",
  "opencode/c",
  "opencode/d",
])
const fk = filterKnown(four, reg)
assert.deepEqual(
  fk.active.map((m) => m.id),
  ["a", "c", "d"],
)
assert.deepEqual(fk.missing, ["opencode/b"])
const skip = filterKnown(four, new Set())
assert.equal(skip.active.length, 4)
assert.equal(skip.missing.length, 0)

console.log("selfcheck OK")
