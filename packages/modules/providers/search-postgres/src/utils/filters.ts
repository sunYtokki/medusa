import { SearchTypes } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import { IndexPlan, PlannedField } from "./plan"

function fail(message: string): never {
  throw new MedusaError(MedusaError.Types.NOT_ALLOWED, message)
}

export type SqlFragment = {
  sql: string
  params: unknown[]
}

/**
 * Builds a JSONB path expression against the `indexed` column for a dotted
 * field path. `variants.color` becomes `indexed->'variants'->'color'`.
 */
export function jsonbPath(path: string, asText = false): string {
  const segments = path.split(".")
  let expr = "indexed"

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].replace(/'/g, "''")
    const isLast = i === segments.length - 1
    if (isLast && asText) {
      expr += `->>'${segment}'`
    } else {
      expr += `->'${segment}'`
    }
  }

  return expr
}

function castScalar(
  planned: PlannedField,
  value: unknown
): string | number | boolean | null {
  if (value === null || value === undefined) {
    return null
  }

  switch (planned.kind) {
    case "number": {
      const num =
        planned.is_date && value instanceof Date
          ? value.getTime()
          : typeof value === "number"
          ? value
          : Number(value)
      if (Number.isNaN(num)) {
        fail(`Cannot cast filter value for "${planned.path}" to a number`)
      }
      return num
    }
    case "boolean":
      if (typeof value === "boolean") {
        return value
      }
      if (value === "true" || value === "false") {
        return value === "true"
      }
      return Boolean(value)
    default:
      return typeof value === "string" ? value : String(value)
  }
}

function nextParam(params: unknown[], value: unknown): string {
  params.push(value)
  return `?`
}

function comparisonSql(
  planned: PlannedField,
  operator: string,
  value: unknown,
  params: unknown[]
): string {
  const cast = castScalar(planned, value)

  if (planned.kind === "number") {
    return `(${jsonbPath(planned.path, true)})::float8 ${operator} ${nextParam(
      params,
      cast
    )}`
  }

  if (planned.kind === "boolean") {
    return `(${jsonbPath(planned.path, true)})::boolean ${operator} ${nextParam(
      params,
      cast
    )}`
  }

  return `${jsonbPath(planned.path, true)} ${operator} ${nextParam(
    params,
    cast
  )}`
}

function membershipSql(
  planned: PlannedField,
  values: unknown[],
  negate: boolean,
  params: unknown[]
): string {
  const castValues = values.map((value) => castScalar(planned, value))

  if (planned.is_array) {
    // MikroORM/`?` placeholders collide with Postgres `?|` / `?&` operators, so
    // the jsonb operators are inlined via `jsonb_exists_any`.
    const fn = negate ? "NOT jsonb_exists_any" : "jsonb_exists_any"
    return `${fn}(${jsonbPath(planned.path)}, ${nextParam(
      params,
      castValues.map(String)
    )}::text[])`
  }

  if (planned.kind === "number") {
    return `(${jsonbPath(planned.path, true)})::float8 ${
      negate ? "NOT IN" : "IN"
    } (${castValues.map((v) => nextParam(params, v)).join(", ")})`
  }

  if (planned.kind === "boolean") {
    if (castValues.length !== 1) {
      fail(
        `Boolean field "${planned.path}" can only be matched against a single value`
      )
    }
    return `(${jsonbPath(planned.path, true)})::boolean ${
      negate ? "IS DISTINCT FROM" : "="
    } ${nextParam(params, castValues[0])}`
  }

  return `${jsonbPath(planned.path, true)} ${
    negate ? "NOT IN" : "IN"
  } (${castValues.map((v) => nextParam(params, v)).join(", ")})`
}

function arrayContainsSql(
  planned: PlannedField,
  values: unknown[],
  mode: "all" | "any",
  params: unknown[]
): string {
  if (!planned.is_array) {
    fail(
      `Operator $${
        mode === "all" ? "contains" : "overlaps"
      } on "${planned.path}" needs an array field`
    )
  }

  const castValues = values.map((value) => String(castScalar(planned, value)))
  const fn = mode === "all" ? "jsonb_exists_all" : "jsonb_exists_any"
  return `${fn}(${jsonbPath(planned.path)}, ${nextParam(
    params,
    castValues
  )}::text[])`
}

function fieldPredicate(
  path: string,
  raw: unknown,
  plan: IndexPlan,
  params: unknown[]
): string {
  const planned = plan.fields.get(path)

  if (!planned) {
    fail(`Unknown filter field "${path}" on the postgres search provider`)
  }

  // Shorthand: bare value or list of values.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const values = Array.isArray(raw) ? raw : [raw]
    if (values.length === 1) {
      return comparisonSql(planned, "=", values[0], params)
    }
    return membershipSql(planned, values, false, params)
  }

  const operators = raw as Record<string, unknown>
  const keys = Object.keys(operators).filter((key) => key.startsWith("$"))

  if (!keys.length) {
    fail(`Empty operator map on filter field "${path}"`)
  }

  const parts: string[] = []

  for (const operator of keys) {
    const value = operators[operator]

    switch (operator) {
      case "$eq":
        parts.push(comparisonSql(planned, "=", value, params))
        break
      case "$ne":
        parts.push(comparisonSql(planned, "IS DISTINCT FROM", value, params))
        break
      case "$in":
        parts.push(
          membershipSql(
            planned,
            Array.isArray(value) ? value : [value],
            false,
            params
          )
        )
        break
      case "$nin":
        parts.push(
          membershipSql(
            planned,
            Array.isArray(value) ? value : [value],
            true,
            params
          )
        )
        break
      case "$gt":
        parts.push(comparisonSql(planned, ">", value, params))
        break
      case "$gte":
        parts.push(comparisonSql(planned, ">=", value, params))
        break
      case "$lt":
        parts.push(comparisonSql(planned, "<", value, params))
        break
      case "$lte":
        parts.push(comparisonSql(planned, "<=", value, params))
        break
      case "$exists": {
        const exists = Boolean(value)
        const expr = jsonbPath(planned.path)
        parts.push(
          exists
            ? `${expr} IS NOT NULL AND ${expr} <> 'null'::jsonb`
            : `${expr} IS NULL OR ${expr} = 'null'::jsonb`
        )
        break
      }
      case "$contains":
        parts.push(
          arrayContainsSql(
            planned,
            Array.isArray(value) ? value : [value],
            "all",
            params
          )
        )
        break
      case "$overlaps":
        parts.push(
          arrayContainsSql(
            planned,
            Array.isArray(value) ? value : [value],
            "any",
            params
          )
        )
        break
      case "$prefix":
        parts.push(
          `${jsonbPath(planned.path, true)} LIKE ${nextParam(
            params,
            `${String(value)}%`
          )}`
        )
        break
      case "$like":
        parts.push(
          `${jsonbPath(planned.path, true)} LIKE ${nextParam(
            params,
            String(value)
          )}`
        )
        break
      default:
        fail(
          `The postgres search provider does not support operator "${operator}" on "${path}"`
        )
    }
  }

  return parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`
}

/**
 * Compiles the filter tree into a SQL boolean expression. Unlike the local
 * provider, `$or` and `$not` are supported — Postgres can express them.
 */
export function toWhereClause(
  filters: SearchTypes.SearchFilters | undefined,
  plan: IndexPlan
): SqlFragment | undefined {
  if (!filters) {
    return undefined
  }

  const params: unknown[] = []

  const compile = (branch: SearchTypes.SearchFilters): string => {
    const parts: string[] = []

    for (const [key, value] of Object.entries(branch)) {
      if (key === "q") {
        continue
      }

      if (key === "$and") {
        const nested = ((value ?? []) as SearchTypes.SearchFilters[])
          .map(compile)
          .filter(Boolean)
        if (nested.length) {
          parts.push(`(${nested.join(" AND ")})`)
        }
        continue
      }

      if (key === "$or") {
        const nested = ((value ?? []) as SearchTypes.SearchFilters[])
          .map(compile)
          .filter(Boolean)
        if (nested.length) {
          parts.push(`(${nested.join(" OR ")})`)
        }
        continue
      }

      if (key === "$not") {
        const nested = compile(value as SearchTypes.SearchFilters)
        if (nested) {
          parts.push(`NOT (${nested})`)
        }
        continue
      }

      parts.push(fieldPredicate(key, value, plan, params))
    }

    return parts.join(" AND ")
  }

  const sql = compile(filters)
  return sql ? { sql, params } : undefined
}
