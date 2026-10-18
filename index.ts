import { appendFileSync, mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Model IDs the rotation must never switch to.
const DEFAULT_EXCLUDE = ["nemotron-3.5-lightning-free"]
const DEFAULT_FILE = "~/src/opencode_free_models.md"
const DEFAULT_RETRY_DELAY_MS = 300
// How long a model stays avoided after a 429.
const COOLDOWN_MS = 10 * 60_000
// Used when the list file is unreadable/empty so the plugin still works.
const FALLBACK_IDS = [
  "beam-free",
  "big-pickle",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-super-vl-free",
  "space-bunny-free",
]

export type ModelRef = { providerID: string; id: string }

/**
 * Extract unique `provider/model` tokens from markdown text, in file order.
 */
export function parseModelList(md: string): ModelRef[] {
  const seen = new Set<string>()
  const out: ModelRef[] = []
  for (const m of md.matchAll(/`([A-Za-z][\w.-]*\/[\w.-]+)`/g)) {
    const token = m[1]
    if (seen.has(token)) continue
    seen.add(token)
    const slash = token.indexOf("/")
    out.push({ providerID: token.slice(0, slash), id: token.slice(slash + 1) })
  }
  return out
}

export async function loadPool(
  file: string,
  exclude: Set<string>,
  last = new Set<string>(),
): Promise<{ pool: ModelRef[]; source: string }> {
  let md: string | undefined
  try {
    md = await readFile(file, "utf8")
  } catch {
    // fall through to builtin list
  }
  const filtered = (list: ModelRef[]) =>
    list.filter((m) => !exclude.has(m.id) && !exclude.has(`${m.providerID}/${m.id}`))
  if (md) {
    const pool = filtered(parseModelList(md))
    if (pool.length) return { pool: reorderLast(pool, last), source: file }
  }
  return {
    pool: reorderLast(filtered(FALLBACK_IDS.map((id) => ({ providerID: "opencode", id }))), last),
    source: "builtin-fallback",
  }
}

/**
 * Move models listed in `last` (by id or provider/id) to the end of the pool,
 * preserving their relative order.
 */
export function reorderLast(pool: ModelRef[], last: Set<string>): ModelRef[] {
  const head: ModelRef[] = []
  const tail: ModelRef[] = []
  for (const m of pool) (last.has(m.id) || last.has(`${m.providerID}/${m.id}`) ? tail : head).push(m)
  return [...head, ...tail]
}

/**
 * Round-robin picker. Pass 1 skips models in cooldown, pass 2 accepts them
 * (when everything is cooling down we still rotate instead of returning nothing).
 */
export function makePicker(getPool: () => ModelRef[]) {
  let idx = -1
  return function pick(currentID?: string, dropped?: Map<string, number>, cooldownMs = 0): ModelRef | undefined {
    const pool = getPool()
    if (!pool.length) return undefined
    const now = Date.now()
    for (const strict of [true, false]) {
      for (let i = 0; i < pool.length; i++) {
        idx = (idx + 1) % pool.length
        const m = pool[idx]
        if (m.id === currentID) continue
        if (strict && dropped) {
          const at = dropped.get(m.id)
          if (at && now - at < cooldownMs) continue
        }
        return m
      }
    }
    return undefined
  }
}

const expandTilde = (p: string) => p.replace(/^~(?=\/|$)/, homedir())

// Plugin stdout is swallowed by the server; keep a dedicated log file for
// diagnosability: ~/.local/share/opencode/log/model-rotation.log
function makeLogger() {
  const logDir = join(homedir(), ".local/share/opencode/log")
  try {
    mkdirSync(logDir, { recursive: true })
  } catch {
    // log write failures are non-fatal
  }
  const logFile = join(logDir, "model-rotation.log")
  return (...a: unknown[]) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${a.map((x) => String(x)).join(" ")}\n`)
    } catch {
      // ignore
    }
  }
}

// Registry outputs vary across hosts/versions; accept array, .data or .models.
function listOf(out: any): any[] {
  if (Array.isArray(out)) return out
  return Array.isArray(out?.data) ? out.data : Array.isArray(out?.models) ? out.models : []
}

/**
 * Split a pool against a model registry: keep only models that actually exist.
 * An empty registry (e.g. not yet materialized at plugin setup) means "skip".
 */
export function filterKnown(list: ModelRef[], known: Set<string>): { active: ModelRef[]; missing: string[] } {
  if (known.size === 0) return { active: [...list], missing: [] }
  const active: ModelRef[] = []
  const missing: string[] = []
  for (const m of list) {
    const token = `${m.providerID}/${m.id}`
    if (known.has(token)) active.push(m)
    else missing.push(token)
  }
  return { active, missing }
}

const RATE_RE = /(^|\W)429(\W|$)|rate.?limit|quota|capacity/i
// Upstream failures that make a pool model unservable right now even though it
// is not rate-out: geo-blocks ("not available in your country"), timeouts,
// 5xx gateway errors. Rotating to another model fixes all of these.
const UNUSABLE_RE = /unavailable|not available|timed?.?out|timeout|upstream|country/i

export function classifyError(e: any): "rate" | "unusable" | undefined {
  if (!e) return undefined
  const text = `${e?.type ?? ""} ${e?.message ?? ""}`
  if (e?.status === 429 || RATE_RE.test(text)) return "rate"
  if (
    e?.status === 403 ||
    e?.status === 408 ||
    (typeof e?.status === "number" && e?.status >= 500 && e?.status < 600) ||
    UNUSABLE_RE.test(text)
  ) {
    return "unusable"
  }
  return undefined
}

// ---------------------------------------------------------------------------
// OpenCode 1.x (V1) support: same package, V1 plugin contract of hooks.
// V1 reality check: no retry hook and no per-session model endpoint, so the
// rotation is reactive — detect session.error, notify via TUI toast and try a
// best-effort session.update with the next pool model.
// ---------------------------------------------------------------------------
export async function FreeLLMRotation(ctx1: any) {
  const client = ctx1?.client
  const log = makeLogger()
  // V1 plugins receive no config options; the file path is overridable via env.
  const file = expandTilde(process.env.MODEL_ROTATION_FILE ?? DEFAULT_FILE)
  const last = new Set<string>(["nemotron-3.5-super-vl-free"])
  let { pool } = await loadPool(file, new Set(DEFAULT_EXCLUDE), last)
  const pick = makePicker(() => pool)
  const dropped = new Map<string, number>()

  // Best-effort registry validation; skip silently if the endpoint differs.
  try {
    const out = await client?.config?.providers?.()
    const known = new Set<string>()
    for (const p of listOf(out?.providers ?? out)) {
      for (const m of listOf((p as any)?.models)) {
        const prov = (p as any)?.id ?? (p as any)?.providerID
        const id = (m as any)?.id ?? (m as any)?.modelID
        if (prov && id) known.add(`${prov}/${id}`)
      }
    }
    const filtered = filterKnown(pool, known)
    if (filtered.missing.length) log(`[v1] not in registry (dropped): ${filtered.missing.join(", ")}`)
    pool = filtered.active
  } catch (e) {
    log("[v1] registry validation skipped:", e)
  }
  log(`[v1] pool=${pool.length} models`)

  const toast = (message: string, variant = "warning") => {
    try {
      void client?.tui
        ?.showToast?.({ body: { message, variant } })
        ?.catch?.((e: any) => log("[v1] toast failed:", e))
    } catch (e) {
      log("[v1] toast failed:", e)
    }
  }

  return {
    event: async ({ event }: any) => {
      try {
        if (event?.type !== "session.error") return
        if (!pool.length) return
        const props = event.properties ?? {}
        const rawError =
          props?.error && typeof props.error === "object" ? props.error : { message: JSON.stringify(props) }
        const cls = classifyError(rawError)
        if (!cls) {
          log(`[v1] session error is not rotatable (${String(rawError.message).slice(0, 120)})`)
          return
        }
        const sessionID = props?.sessionID
        if (!sessionID) return

        // The failed model: prefer the event payload, else the session record.
        let failed = (props?.error?.model ?? props?.model) as any
        if (!failed && client?.session?.get) {
          try {
            const s = await client.session.get({ path: { id: sessionID } })
            failed = s?.data?.model ?? s?.model
          } catch {
            // session lookup is optional
          }
        }
        const failedId = failed?.modelID ?? failed?.id
        if (!failedId || !pool.some((p) => p.id === failedId)) {
          log(`[v1] error on non-pool model ${failedId ?? "?"}, not rotating`)
          return
        }

        dropped.set(failedId, Date.now())
        const next = pick(failedId, dropped, COOLDOWN_MS)
        let detail = `${cls === "rate" ? "лимит/квота" : "недоступна"}`
        let switched = false
        if (next) {
          try {
            await client.session.update?.({
              path: { id: sessionID },
              body: { model: { providerID: next.providerID, modelID: next.id, id: next.id } },
            })
            switched = true
            log(`[v1] opencode/${failedId} -> opencode/${next.id} (${cls}, session ${sessionID})`)
          } catch (e) {
            log("[v1] session.update failed:", e)
          }
          if (switched) detail += `: switched to opencode/${next.id}`
          else detail += `: переключите модель вручную (/models)`
        } else {
          detail += `: весь пул остывает, переключитесь вручную (/models)`
        }
        toast(`🔄 [model-rotation] opencode/${failedId} — ${detail}`)
      } catch (e) {
        log("[v1] event hook error:", e)
      }
    },
  }
}

export default {
  id: "model-rotation",
  // V1 loaders (>=1.18.29) read this; V2 ignores it. Named `FreeLLMRotation`
  // export covers older V1 releases that expect plugin functions.
  server: FreeLLMRotation,
  async setup(ctx: any) {
    const opts = ctx.options ?? {}
    const file = expandTilde(String(opts.file ?? DEFAULT_FILE))
    const retryDelay = typeof opts.retryDelay === "number" ? opts.retryDelay : DEFAULT_RETRY_DELAY_MS
    const exclude = new Set<string>(
      Array.isArray(opts.exclude) ? opts.exclude.map(String) : DEFAULT_EXCLUDE,
    )
    // Models that should be tried last (стойкие до деградаций, слабые или медленные).
    const last = new Set<string>(
      Array.isArray(opts.last) ? opts.last.map(String) : ["nemotron-3.5-super-vl-free"],
    )

    let { pool, source } = await loadPool(file, exclude, last)

    // Drop models that do not exist in OpenCode's model registry (refreshed
    // also by /rotation refresh). An empty registry means "not ready" — skip.
    let known = new Set<string>()
    let offRegistry: string[] = []
    const refreshKnown = async () => {
      known = new Set()
      try {
        for (const m of listOf(await ctx.model.list())) {
          const prov = (m as any).providerID
          const id = (m as any).id ?? (m as any).modelID
          if (prov && id) known.add(`${prov}/${id}`)
        }
      } catch (e) {
        log("model registry read failed:", e)
        known = new Set()
      }
    }
    await refreshKnown()
    ;({ active: pool, missing: offRegistry } = filterKnown(pool, known))
    if (offRegistry.length) log(`not in registry (dropped from rotation): ${offRegistry.join(", ")}`)
    const pick = makePicker(() => pool)
    const dropped = new Map<string, number>()
    let enabled = (await ctx.storage.get("enabled")) !== false
    let lastPick: string | undefined

    const log = makeLogger()
    log(`pool=${pool.length} models (source: ${source}); enabled=${enabled}`)

    const rotateFromTo = async (sessionID: string, from: string) => {
      const next = pick(from, dropped, COOLDOWN_MS)
      if (!next) return undefined
      await ctx.session.switchModel({ sessionID, model: { providerID: next.providerID, id: next.id } })
      lastPick = next.id
      log(`opencode/${from} -> opencode/${next.id} (session ${sessionID})`)
      return next
    }

    // In-session notice about a switch: synthetic message, never throws.
    const notify = (sessionID: string, text: string) => {
      void ctx.session
        .synthetic({ sessionID, text })
        .catch((e: unknown) => log("notification failed:", e))
    }

    // Failover: a pool model hit 429/limit or is otherwise unservable right
    // now (geo-block, timeout, 5xx) -> mark it cooling, switch the session to
    // the next model and let the retry attempt use it.
    await ctx.session.hook("retry", async (event: any) => {
      try {
        if (!enabled) return
        const failed = event.model
        if (!failed || !pool.some((p) => p.id === failed.id)) return
        const cls = classifyError(event.error)
        if (!cls) {
          log(
            `${failed.id} failed with ${event.error?.type ?? "(no type)"} (status ${event.error?.status ?? "?"}) — not a rotatable failure, not rotating`,
          )
          return
        }
        dropped.set(failed.id, Date.now())
        const next = await rotateFromTo(event.sessionID, failed.id)
        if (!next) {
          log(`all pool models cooling down; stopping retry`)
          event.decision = { retry: false }
          return
        }
        const detail = [event.error?.type, event.error?.status].filter(Boolean).join(" ")
        const reason =
          `${cls === "rate" ? "лимит/квота" : "недоступна"}` +
          (detail ? ` (${detail})` : "") +
          (event.error?.message ? `: ${String(event.error.message).slice(0, 90)}` : "")
        notify(
          event.sessionID,
          `🔄 [model-rotation] opencode/${failed.id} → opencode/${next.id} — ${reason}` +
            (typeof event.attempt === "number" ? ` (попытка ${event.attempt})` : ""),
        )
        log(`rotated (${cls}: ${event.error?.type ?? "?"} ${event.error?.status ?? "??"})`)
        event.decision = { retry: true, delay: retryDelay }
      } catch (e) {
        log("retry hook error:", e)
      }
    })

    // Safety net: if the session still points at a cooling model when the user
    // sends the next prompt, switch before that turn starts.
    await ctx.session.hook("prompt", async (event: any) => {
      try {
        if (!enabled) return
        const session = await ctx.session.get({ sessionID: event.sessionID })
        const cur = session?.model
        if (!cur || !pool.some((p) => p.id === cur.id)) return
        const at = dropped.get(cur.id)
        if (!at || Date.now() - at >= COOLDOWN_MS) return
        const next = await rotateFromTo(event.sessionID, cur.id)
        if (next) {
          notify(
            event.sessionID,
            `🔄 [model-rotation] opencode/${cur.id} → opencode/${next.id} — модель остывает после недавнего отказа`,
          )
        }
      } catch (e) {
        log("prompt hook error:", e)
      }
    })

    const statusText = () => {
      const now = Date.now()
      const cooling = [...dropped.entries()]
        .filter(([, at]) => now - at < COOLDOWN_MS)
        .map(([id, at]) => `  - opencode/${id} (${((COOLDOWN_MS - (now - at)) / 60000).toFixed(1)}min)`)
      return (
        `Model rotation: ${enabled ? "ON" : "OFF"}\n` +
        `pool: ${pool.length} models${offRegistry.length ? ` (+${offRegistry.length} not in registry)` : ""} (source: ${source})\n` +
        (lastPick ? `last switched to: opencode/${lastPick}\n` : "") +
        (cooling.length ? `cooling down:\n${cooling.join("\n")}` : "")
      )
    }

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "rotation",
        description: "Free-model rotation: on | off | status | list | refresh",
        execute: async (invocation: any) => {
          const sessionID = invocation.sessionID
          const raw = String(invocation.prompt?.text ?? "")
            .replace(/^\//, "")
            .replace(/^rotation\b/i, "")
            .trim()
            .toLowerCase()
          let reply: string
          if (raw === "on" || raw === "off") {
            enabled = raw === "on"
            await ctx.storage.set("enabled", enabled)
            reply = statusText()
          } else if (raw === "list") {
            reply = `pool (${pool.length}):\n` + pool.map((m) => `- opencode/${m.id}`).join("\n")
          } else if (raw === "refresh") {
            await refreshKnown()
            const loaded = await loadPool(file, exclude, last)
            pool = loaded.pool
            source = loaded.source
            ;({ active: pool, missing: offRegistry } = filterKnown(pool, known))
            if (offRegistry.length) log(`not in registry (dropped from rotation): ${offRegistry.join(", ")}`)
            reply =
              statusText() +
              (offRegistry.length ? `\nnot in registry (not rotating): ${offRegistry.join(", ")}` : "")
          } else if (raw === "" || raw === "status") {
            if (raw === "") {
              enabled = !enabled
              await ctx.storage.set("enabled", enabled)
            }
            reply = statusText()
          } else {
            reply = "usage: /rotation [on|off|status|list|refresh]"
          }
          try {
            await ctx.session.synthetic({ sessionID, text: reply })
          } catch (e) {
            log("confirmation failed:", e)
          }
        },
      })
    })

    log("ready")
    return () => log("unloaded")
  },
}
