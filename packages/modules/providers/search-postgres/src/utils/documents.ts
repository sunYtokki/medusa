import { SearchTypes } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { IndexPlan, PlannedField, weightLabel } from "./plan"

function fail(message: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message)
}

/**
 * Walks a dotted path, flattening through arrays encountered on the way — the
 * same collapse the local provider uses, so a definition stays portable.
 */
export function readPath(source: unknown, segments: string[]): unknown[] {
  let current: unknown[] = [source]

  for (const segment of segments) {
    const next: unknown[] = []

    for (const value of current) {
      if (value === null || value === undefined) {
        continue
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          const resolved = (entry as Record<string, unknown>)?.[segment]
          if (resolved !== undefined) {
            next.push(resolved)
          }
        }
        continue
      }
      const resolved = (value as Record<string, unknown>)?.[segment]
      if (resolved !== undefined) {
        next.push(resolved)
      }
    }

    current = next
  }

  return current.flat(Infinity).filter((v) => v !== null && v !== undefined)
}

function setPath(target: Record<string, any>, path: string, value: unknown) {
  const segments = path.split(".")
  let cursor = target

  for (const segment of segments.slice(0, -1)) {
    cursor[segment] ??= {}
    cursor = cursor[segment]
  }

  cursor[segments[segments.length - 1]] = value
}

function toNumber(value: unknown, isDate: boolean): number | undefined {
  const num = isDate
    ? value instanceof Date
      ? value.getTime()
      : Date.parse(String(value))
    : typeof value === "number"
    ? value
    : Number(value)

  return Number.isNaN(num) ? undefined : num
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value
  }
  if (value === "true" || value === "false") {
    return value === "true"
  }
  return Boolean(value)
}

function coerce(value: unknown, planned: PlannedField): unknown {
  switch (planned.kind) {
    case "number":
      return toNumber(value, planned.is_date)
    case "boolean":
      return toBoolean(value)
    case "text":
    case "keyword":
      return typeof value === "string" ? value : String(value)
    case "vector":
      return value
    default:
      return value
  }
}

function coerceVector(
  value: unknown,
  planned: PlannedField
): number[] | undefined {
  if (!Array.isArray(value)) {
    fail(
      `Vector field "${planned.path}" must be a numeric array of length ${planned.dimensions}`
    )
  }

  const nums = value.map((entry) => Number(entry))
  if (nums.some((n) => Number.isNaN(n))) {
    fail(`Vector field "${planned.path}" contains non-numeric components`)
  }

  if (planned.dimensions && nums.length !== planned.dimensions) {
    fail(
      `Vector field "${planned.path}" expected ${planned.dimensions} dimensions, got ${nums.length}`
    )
  }

  return nums
}

/**
 * Projects a source document onto the indexed shape used for filters and FTS,
 * and returns the primary key plus the searchable plain-text blob and vectors.
 */
export function projectIndexedDocument(
  document: SearchTypes.SearchDocument,
  plan: IndexPlan
): {
  id: string
  indexed: Record<string, unknown>
  search_text: string
  weighted_parts: { text: string; weight: "A" | "B" | "C" | "D" }[]
  vectors: Record<string, number[]>
} {
  const indexed: Record<string, any> = {}
  const textParts: string[] = []
  const weighted_parts: { text: string; weight: "A" | "B" | "C" | "D" }[] = []
  const vectors: Record<string, number[]> = {}

  for (const planned of plan.fields.values()) {
    const values = readPath(document, planned.path.split(".")).filter(
      (value) => value !== undefined && value !== null
    )

    if (!values.length) {
      continue
    }

    if (planned.kind === "vector") {
      const embedding = coerceVector(values[0], planned)
      if (embedding) {
        vectors[planned.path] = embedding
      }
      continue
    }

    const coerced = values
      .map((value) => coerce(value, planned))
      .filter((value) => value !== undefined)

    if (!coerced.length) {
      continue
    }

    const value = planned.is_array ? coerced : coerced[0]
    setPath(indexed, planned.path, value)

    if (
      planned.kind === "text" ||
      planned.kind === "keyword" ||
      (planned.kind === "number" && !planned.is_date)
    ) {
      const asText = (Array.isArray(value) ? value : [value])
        .map((entry) => String(entry))
        .join(" ")

      if (
        planned.field.searchable === true ||
        typeof planned.field.searchable === "object"
      ) {
        textParts.push(asText)
        weighted_parts.push({
          text: asText,
          weight: weightLabel(planned.field.searchable),
        })
      }
    }
  }

  const primaryKey = document[plan.primary_key]

  if (primaryKey === undefined || primaryKey === null || primaryKey === "") {
    fail(
      `A document written to the postgres search provider is missing its primary key "${plan.primary_key}"`
    )
  }

  return {
    id: String(primaryKey),
    indexed,
    search_text: textParts.join(" "),
    weighted_parts,
    vectors,
  }
}

/**
 * Narrows a source document to the requested dotted paths.
 */
export function projectDocument(
  source: Record<string, unknown>,
  paths: string[]
): Record<string, unknown> {
  const picked: Record<string, any> = {}

  for (const path of paths) {
    const segments = path.split(".")
    const [head, ...rest] = segments
    const value = source?.[head]

    if (value === undefined) {
      continue
    }

    if (!rest.length) {
      picked[head] = value
      continue
    }

    if (Array.isArray(value)) {
      const existing = Array.isArray(picked[head]) ? picked[head] : []
      picked[head] = value.map((entry, i) =>
        Object.assign(
          existing[i] ?? {},
          projectDocument(entry as Record<string, unknown>, [rest.join(".")])
        )
      )
    } else if (value && typeof value === "object") {
      picked[head] = Object.assign(
        picked[head] ?? {},
        projectDocument(value as Record<string, unknown>, [rest.join(".")])
      )
    }
  }

  return picked
}

/**
 * Recognises a filter that is nothing but primary-key membership, so a delete
 * goes straight to `DELETE ... WHERE id = ANY(...)`.
 */
export function extractPrimaryKeyFilter(
  filters: SearchTypes.SearchFilters,
  plan: IndexPlan
): string[] | undefined {
  const keys = Object.keys(filters)

  if (keys.length !== 1 || keys[0] !== plan.primary_key) {
    return undefined
  }

  const predicate = filters[plan.primary_key]

  const asIds = (value: unknown): string[] | undefined => {
    const values = Array.isArray(value) ? value : [value]
    return values.every((v) => typeof v === "string")
      ? (values as string[])
      : undefined
  }

  if (predicate === null || typeof predicate !== "object") {
    return asIds(predicate)
  }

  if (Array.isArray(predicate)) {
    return asIds(predicate)
  }

  const operators = Object.keys(predicate)

  if (operators.length !== 1) {
    return undefined
  }

  if (operators[0] === "$eq" || operators[0] === "$in") {
    return asIds((predicate as Record<string, unknown>)[operators[0]])
  }

  return undefined
}
