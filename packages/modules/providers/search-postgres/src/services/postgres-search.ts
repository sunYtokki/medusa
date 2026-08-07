import { Logger, SearchTypes } from "@medusajs/framework/types"
import {
  AbstractSearchProviderService,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  assertIndexSupported,
  assertQuerySupported,
  bm25IndexName,
  buildFacetQuery,
  buildIndexPlan,
  CATALOG_TABLE,
  ensureSearchExtensions,
  ExtensionState,
  extractPrimaryKeyFilter,
  IndexPlan,
  mapFacetResult,
  normalizeFacetRequests,
  PostgresSearchEngine,
  PostgresSearchEmbedder,
  PostgresSearchProviderOptions,
  PostgresVectorDistance,
  projectDocument,
  projectIndexedDocument,
  sameSchema,
  similarityCall,
  tableNameForIndex,
  toWhereClause,
  vectorColumnName,
  vectorDistanceOperator,
  vectorOpClass,
  weightLabel,
} from "../utils"

type DbManager = {
  execute: (sql: string, params?: unknown[]) => Promise<any[]>
  transactional?: <T>(cb: (manager: DbManager) => Promise<T>) => Promise<T>
}

type InjectedDependencies = {
  manager: DbManager
  logger?: Logger
}

type CatalogRow = {
  name: string
  table_name: string
  schema_hash: string
  plan: unknown
  document_count: number | string
  created_at: Date | string
  updated_at: Date | string
}

type StoredIndex = {
  name: string
  table_name: string
  schema_hash: string
  plan: IndexPlan
  document_count: number
  created_at: Date | string
  updated_at: Date | string
}

/**
 * PostgreSQL search provider with two engines:
 *
 * - `native` (default) — portable GIN + `ts_rank` + `pg_trgm`
 * - `lakebase` — Neon Lakebase Search (`lakebase_bm25` + `lakebase_ann`)
 *
 * Medusa Cloud uses `engine: "lakebase"`. Local / self-hosted stick to native.
 */
export class PostgresSearchService extends AbstractSearchProviderService {
  static identifier = "search-postgres"

  protected readonly manager_: DbManager
  protected readonly logger_?: Logger
  protected readonly language_: string
  protected readonly engine_: PostgresSearchEngine
  protected readonly embedder_?: PostgresSearchEmbedder
  protected readonly vectorDistance_: PostgresVectorDistance
  protected extensionState_: ExtensionState | null = null

  constructor(
    { manager, logger }: InjectedDependencies,
    options: PostgresSearchProviderOptions = {}
  ) {
    super()

    if (!manager?.execute) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "The postgres search provider requires a database manager. Ensure the Search Module is configured with a Postgres connection."
      )
    }

    this.manager_ = manager
    this.logger_ = logger
    this.language_ = this.normalizeLanguage(options.language ?? "english")
    this.engine_ = options.engine ?? "native"
    this.embedder_ = options.embedder
    this.vectorDistance_ = options.vector_distance ?? "cosine"

    if (this.engine_ !== "native" && this.engine_ !== "lakebase") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid postgres search engine "${options.engine}". Use "native" or "lakebase".`
      )
    }
  }

  protected normalizeLanguage(language: string): string {
    if (!/^[a-z0-9_]+$/i.test(language)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid postgres search language "${language}". Use a built-in text search configuration name such as "english" or "simple".`
      )
    }
    return language
  }

  protected get tsConfig_(): string {
    return this.extensionState_?.text_search_config ?? this.language_
  }

  protected get isLakebase_(): boolean {
    return this.engine_ === "lakebase"
  }

  protected async ensureExtensions(
    manager: DbManager = this.manager_
  ): Promise<ExtensionState> {
    if (this.extensionState_) {
      return this.extensionState_
    }

    try {
      this.extensionState_ = await ensureSearchExtensions(manager, {
        language: this.language_,
        catalogTable: CATALOG_TABLE,
        engine: this.engine_,
      })
    } catch (error) {
      if (error instanceof MedusaError) {
        throw error
      }
      throw new MedusaError(
        MedusaError.Types.DB_ERROR,
        `Failed to initialize the postgres search catalog. Underlying error: ${
          (error as Error).message
        }`
      )
    }

    if (!this.extensionState_.pg_trgm) {
      this.logger_?.warn(
        "search-postgres: pg_trgm is not available. Full-text search will work, but typo_tolerance queries will be rejected."
      )
    }

    return this.extensionState_
  }

  protected assertTypoToleranceAvailable(state: ExtensionState) {
    if (!state.pg_trgm) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Typo tolerance requires the pg_trgm extension. Enable it with: CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      )
    }
  }

  protected serializePlan(plan: IndexPlan): string {
    return JSON.stringify({
      primary_key: plan.primary_key,
      searchable: plan.searchable,
      vectors: plan.vectors,
      schema_hash: plan.schema_hash,
      fields: [...plan.fields.values()].map((planned) => ({
        path: planned.path,
        kind: planned.kind,
        is_array: planned.is_array,
        is_date: planned.is_date,
        dimensions: planned.dimensions,
        field: planned.field,
      })),
    })
  }

  protected deserializePlan(raw: unknown): IndexPlan {
    const data =
      typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, any>)

    const fields = new Map(
      (data.fields as any[]).map((entry) => [
        entry.path,
        {
          path: entry.path,
          kind: entry.kind,
          is_array: entry.is_array,
          is_date: entry.is_date,
          dimensions: entry.dimensions,
          field: entry.field,
        },
      ])
    )

    return {
      primary_key: data.primary_key,
      searchable: data.searchable ?? [],
      vectors:
        data.vectors ??
        [...fields.values()]
          .filter((f) => f.kind === "vector")
          .map((f) => f.path),
      schema_hash: data.schema_hash,
      fields,
    }
  }

  protected async getCatalog(
    name: string,
    manager: DbManager = this.manager_
  ): Promise<StoredIndex | null> {
    const rows = (await manager.execute(
      `SELECT * FROM "${CATALOG_TABLE}" WHERE "name" = ?`,
      [name]
    )) as CatalogRow[]

    if (!rows.length) {
      return null
    }

    const row = rows[0]
    return {
      name: row.name,
      table_name: row.table_name,
      schema_hash: row.schema_hash,
      plan: this.deserializePlan(row.plan),
      document_count: Number(row.document_count),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  protected async createDocumentTable(
    table: string,
    plan: IndexPlan,
    manager: DbManager,
    extensions: ExtensionState
  ) {
    const vectorColumns = plan.vectors
      .map((path) => {
        const planned = plan.fields.get(path)!
        const col = vectorColumnName(path)
        return `"${col}" vector(${planned.dimensions})`
      })
      .join(",\n        ")

    await manager.execute(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        "id" text NOT NULL,
        "document" jsonb NOT NULL,
        "indexed" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "search_vector" tsvector NOT NULL DEFAULT ''::tsvector,
        "search_text" text NOT NULL DEFAULT '',
        ${vectorColumns ? `${vectorColumns},` : ""}
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "${table}_pkey" PRIMARY KEY ("id")
      )
    `)

    // Add vector columns if the table already existed without them.
    for (const path of plan.vectors) {
      const planned = plan.fields.get(path)!
      const col = vectorColumnName(path)
      await manager.execute(`
        ALTER TABLE "${table}"
        ADD COLUMN IF NOT EXISTS "${col}" vector(${planned.dimensions})
      `)
    }

    if (this.isLakebase_) {
      // BM25 index is created lazily after documents exist (corpus stats).
      await manager.execute(`DROP INDEX IF EXISTS "${table}_fts_idx"`)
    } else {
      await manager.execute(
        `CREATE INDEX IF NOT EXISTS "${table}_fts_idx" ON "${table}" USING GIN ("search_vector")`
      )
    }

    if (extensions.pg_trgm) {
      await manager.execute(
        `CREATE INDEX IF NOT EXISTS "${table}_trgm_idx" ON "${table}" USING GIN ("search_text" gin_trgm_ops)`
      )
    }

    await manager.execute(
      `CREATE INDEX IF NOT EXISTS "${table}_indexed_idx" ON "${table}" USING GIN ("indexed" jsonb_path_ops)`
    )

    if (this.isLakebase_ && extensions.lakebase_vector) {
      const opClass = vectorOpClass(this.vectorDistance_)
      for (const path of plan.vectors) {
        const col = vectorColumnName(path)
        await manager.execute(`
          CREATE INDEX IF NOT EXISTS "${table}_${col}_ann"
          ON "${table}" USING lakebase_ann ("${col}" ${opClass})
        `)
      }
    }
  }

  protected async ensureBm25Index(
    table: string,
    manager: DbManager = this.manager_
  ) {
    if (!this.isLakebase_) {
      return
    }

    const name = bm25IndexName(table)
    await manager.execute(`
      CREATE INDEX IF NOT EXISTS "${name}"
      ON "${table}" USING lakebase_bm25 ("search_vector")
      WITH (default_limit = 1000)
    `)
  }

  protected async dropBm25Index(
    table: string,
    manager: DbManager = this.manager_
  ) {
    if (!this.isLakebase_) {
      return
    }
    await manager.execute(`DROP INDEX IF EXISTS "${bm25IndexName(table)}"`)
  }

  protected async dropDocumentTable(table: string, manager: DbManager) {
    await manager.execute(`DROP TABLE IF EXISTS "${table}" CASCADE`)
  }

  protected async refreshDocumentCount(
    name: string,
    table: string,
    manager: DbManager = this.manager_
  ) {
    const [{ count }] = await manager.execute(
      `SELECT COUNT(*)::int AS count FROM "${table}"`
    )

    await manager.execute(
      `UPDATE "${CATALOG_TABLE}"
       SET "document_count" = ?, "updated_at" = now()
       WHERE "name" = ?`,
      [Number(count ?? 0), name]
    )
  }

  protected async withTransaction<T>(
    run: (manager: DbManager) => Promise<T>
  ): Promise<T> {
    if (this.manager_.transactional) {
      return await this.manager_.transactional(run)
    }
    return await run(this.manager_)
  }

  async upsertIndex({
    index,
  }: {
    index: SearchTypes.ResolvedSearchIndexDefinition
  }): Promise<SearchTypes.SearchTask> {
    assertIndexSupported(index, this.engine_)
    const extensions = await this.ensureExtensions()
    const plan = buildIndexPlan(index)
    const table = tableNameForIndex(index.physical_name)
    const existing = await this.getCatalog(index.physical_name)

    await this.withTransaction(async (manager) => {
      if (existing && !sameSchema(existing.plan, plan) && existing.table_name) {
        await this.dropDocumentTable(existing.table_name, manager)
      }

      await this.createDocumentTable(table, plan, manager, extensions)

      const planJson = this.serializePlan(plan)

      if (existing) {
        await manager.execute(
          `UPDATE "${CATALOG_TABLE}"
           SET "table_name" = ?, "schema_hash" = ?, "plan" = ?::jsonb, "updated_at" = now()
           WHERE "name" = ?`,
          [table, plan.schema_hash, planJson, index.physical_name]
        )
      } else {
        await manager.execute(
          `INSERT INTO "${CATALOG_TABLE}"
            ("name", "table_name", "schema_hash", "plan", "document_count")
           VALUES (?, ?, ?, ?::jsonb, 0)`,
          [index.physical_name, table, plan.schema_hash, planJson]
        )
      }
    })

    return this.task(index.physical_name)
  }

  async deleteIndex({
    index,
  }: {
    index: string
  }): Promise<SearchTypes.SearchTask> {
    await this.ensureExtensions()
    const existing = await this.getCatalog(index)

    if (existing) {
      await this.dropDocumentTable(existing.table_name, this.manager_)
      await this.manager_.execute(
        `DELETE FROM "${CATALOG_TABLE}" WHERE "name" = ?`,
        [index]
      )
    }

    return this.task(index)
  }

  async listIndexes(): Promise<SearchTypes.SearchIndexInfo[]> {
    await this.ensureExtensions()

    const rows = (await this.manager_.execute(
      `SELECT "name", "document_count", "created_at", "updated_at"
       FROM "${CATALOG_TABLE}"
       ORDER BY "name"`
    )) as CatalogRow[]

    return rows.map((row) => ({
      name: row.name,
      provider: PostgresSearchService.identifier,
      document_count: Number(row.document_count),
      created_at:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
      updated_at:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    }))
  }

  async swapIndex({
    alias,
    index,
  }: {
    alias: string
    index: string
  }): Promise<SearchTypes.SearchTask> {
    await this.ensureExtensions()

    const shadow = await this.getCatalog(index)
    if (!shadow) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `The postgres search provider has no index "${index}" to swap from`
      )
    }

    const live = await this.getCatalog(alias)
    const aliasTable = tableNameForIndex(alias)

    await this.withTransaction(async (manager) => {
      if (live) {
        const retired = `${live.table_name}_retired_${Date.now()}`
        await manager.execute(
          `ALTER TABLE IF EXISTS "${live.table_name}" RENAME TO "${retired}"`
        )
        await this.dropDocumentTable(retired, manager)
        await manager.execute(
          `DELETE FROM "${CATALOG_TABLE}" WHERE "name" = ?`,
          [alias]
        )
      }

      if (shadow.table_name !== aliasTable) {
        await manager.execute(
          `ALTER TABLE "${shadow.table_name}" RENAME TO "${aliasTable}"`
        )
      }

      await manager.execute(`DELETE FROM "${CATALOG_TABLE}" WHERE "name" = ?`, [
        index,
      ])

      await manager.execute(
        `INSERT INTO "${CATALOG_TABLE}"
          ("name", "table_name", "schema_hash", "plan", "document_count", "created_at", "updated_at")
         VALUES (?, ?, ?, ?::jsonb, ?, ?, now())`,
        [
          alias,
          aliasTable,
          shadow.plan.schema_hash,
          this.serializePlan(shadow.plan),
          shadow.document_count,
          shadow.created_at instanceof Date
            ? shadow.created_at
            : new Date(shadow.created_at),
        ]
      )

      // BM25 index name is tied to the table; recreate after rename.
      await this.dropBm25Index(aliasTable, manager)
      if (shadow.document_count > 0) {
        await this.ensureBm25Index(aliasTable, manager)
      }
    })

    return this.task(alias)
  }

  protected buildSearchVectorSql(
    weightedParts: { text: string; weight: "A" | "B" | "C" | "D" }[],
    params: unknown[]
  ): string {
    if (!weightedParts.length) {
      return `''::tsvector`
    }

    return weightedParts
      .map((part) => {
        params.push(part.text)
        return `setweight(to_tsvector('${this.tsConfig_}', coalesce(?, '')), '${part.weight}')`
      })
      .join(" || ")
  }

  async upsertDocuments({
    index,
    documents,
  }: {
    index: string
    documents: SearchTypes.SearchDocument[]
  }): Promise<SearchTypes.SearchTask> {
    await this.ensureExtensions()
    const catalog = await this.retrieve(index)

    for (const document of documents) {
      const projected = projectIndexedDocument(document, catalog.plan)
      const vectorParams: unknown[] = []
      const vectorSql = this.buildSearchVectorSql(
        projected.weighted_parts,
        vectorParams
      )

      const vectorCols: string[] = []
      const vectorPlaceholders: string[] = []
      const vectorValues: unknown[] = []
      const vectorUpdates: string[] = []

      for (const path of catalog.plan.vectors) {
        const col = vectorColumnName(path)
        vectorCols.push(`"${col}"`)
        vectorPlaceholders.push(`?::vector`)
        const embedding = projected.vectors[path]
        vectorValues.push(
          embedding ? `[${embedding.join(",")}]` : null
        )
        vectorUpdates.push(`"${col}" = EXCLUDED."${col}"`)
      }

      const extraCols = vectorCols.length ? `, ${vectorCols.join(", ")}` : ""
      const extraPlaceholders = vectorPlaceholders.length
        ? `, ${vectorPlaceholders.join(", ")}`
        : ""
      const extraUpdates = vectorUpdates.length
        ? `, ${vectorUpdates.join(", ")}`
        : ""

      await this.manager_.execute(
        `
        INSERT INTO "${catalog.table_name}"
          ("id", "document", "indexed", "search_vector", "search_text"${extraCols}, "updated_at")
        VALUES (?, ?::jsonb, ?::jsonb, ${vectorSql}, ?${extraPlaceholders}, now())
        ON CONFLICT ("id") DO UPDATE SET
          "document" = EXCLUDED."document",
          "indexed" = EXCLUDED."indexed",
          "search_vector" = EXCLUDED."search_vector",
          "search_text" = EXCLUDED."search_text"${extraUpdates},
          "updated_at" = now()
        `,
        [
          projected.id,
          JSON.stringify(document),
          JSON.stringify(projected.indexed),
          ...vectorParams,
          projected.search_text,
          ...vectorValues,
        ]
      )
    }

    await this.refreshDocumentCount(index, catalog.table_name)

    // Create the BM25 index once documents exist (corpus stats need rows).
    if (this.isLakebase_ && documents.length) {
      await this.ensureBm25Index(catalog.table_name)
    }

    return this.task(index)
  }

  async deleteDocuments({
    index,
    filters,
  }: SearchTypes.SearchDeleteDocumentsInput): Promise<SearchTypes.SearchTask> {
    await this.ensureExtensions()
    const catalog = await this.retrieve(index)

    const ids = extractPrimaryKeyFilter(filters, catalog.plan)
    if (ids) {
      if (ids.length) {
        await this.manager_.execute(
          `DELETE FROM "${catalog.table_name}" WHERE "id" = ANY(?::text[])`,
          [ids]
        )
      }
    } else {
      const where = toWhereClause(filters, catalog.plan)
      if (where?.sql) {
        await this.manager_.execute(
          `DELETE FROM "${catalog.table_name}" WHERE ${where.sql}`,
          where.params
        )
      }
    }

    await this.refreshDocumentCount(index, catalog.table_name)
    return this.task(index)
  }

  async clearIndex({
    index,
  }: {
    index: string
  }): Promise<SearchTypes.SearchTask> {
    await this.ensureExtensions()
    const catalog = await this.retrieve(index)

    await this.dropBm25Index(catalog.table_name)
    await this.manager_.execute(`TRUNCATE TABLE "${catalog.table_name}"`)
    await this.refreshDocumentCount(index, catalog.table_name)

    return this.task(index)
  }

  async search(
    input: SearchTypes.ProviderSearchQuery
  ): Promise<SearchTypes.SearchResult> {
    const extensions = await this.ensureExtensions()
    assertQuerySupported(input, this.engine_)

    const catalog = await this.retrieve(input.index.physical_name)
    const options = input.search_options ?? {}
    const skip = input.pagination?.skip ?? 0
    const take = input.pagination?.take ?? 20
    const started = Date.now()

    for (const path of options.attributes_to_search_on ?? []) {
      if (!catalog.plan.searchable.includes(path)) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Field "${path}" is not searchable on search index "${input.index.name}"`
        )
      }
    }

    const q = input.q?.trim()
    const vectorOpts = options.vector
    const semanticRatio =
      vectorOpts?.semantic_ratio ??
      (q && vectorOpts ? 0.5 : vectorOpts ? 1 : 0)

    if (q && !catalog.plan.searchable.length && semanticRatio < 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Search index "${input.index.name}" has no searchable fields, so it cannot be queried by text`
      )
    }

    if (options.typo_tolerance && q) {
      this.assertTypoToleranceAvailable(extensions)
    }

    let queryEmbedding: number[] | undefined
    if (vectorOpts && semanticRatio > 0) {
      queryEmbedding = await this.resolveQueryEmbedding(
        vectorOpts,
        catalog.plan
      )
    }

    const useKeyword = !!q && semanticRatio < 1
    const useVector = !!queryEmbedding && semanticRatio > 0

    let hitRows: any[]
    let count: number | null

    if (useKeyword && useVector) {
      ;({ hitRows, count } = await this.searchHybrid({
        input,
        catalog,
        extensions,
        queryEmbedding: queryEmbedding!,
        semanticRatio,
        skip,
        take,
      }))
    } else if (useVector) {
      ;({ hitRows, count } = await this.searchVector({
        input,
        catalog,
        queryEmbedding: queryEmbedding!,
        skip,
        take,
      }))
    } else {
      ;({ hitRows, count } = await this.searchKeyword({
        input,
        catalog,
        extensions,
        skip,
        take,
      }))
    }

    const facets = await this.resolveFacets({
      table: catalog.table_name,
      plan: catalog.plan,
      filterWhere: toWhereClause(input.filters, catalog.plan),
      requests: options.facets as
        | (string | SearchTypes.SearchFacetRequest)[]
        | undefined,
    })

    return {
      hits: hitRows.map((row: any) => {
        const document =
          typeof row.document === "string"
            ? JSON.parse(row.document)
            : row.document

        return {
          id: row.id,
          score: options.include_score ? Number(row.score) : undefined,
          document: projectDocument(document, input.attributes_to_retrieve),
        }
      }),
      facets,
      metadata: {
        skip,
        take,
        count: options.count === "none" ? null : count,
        query: input.q,
        processing_time_ms: Date.now() - started,
      },
    }
  }

  protected async resolveQueryEmbedding(
    vectorOpts: NonNullable<SearchTypes.SearchOptions["vector"]>,
    plan: IndexPlan
  ): Promise<number[]> {
    const field = vectorOpts.field
    const planned = plan.fields.get(field)

    if (!planned || planned.kind !== "vector") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Vector search field "${field}" is not a vector field on this index`
      )
    }

    if (vectorOpts.value) {
      if (vectorOpts.value.length !== planned.dimensions) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Vector value for "${field}" expected ${planned.dimensions} dimensions, got ${vectorOpts.value.length}`
        )
      }
      return vectorOpts.value
    }

    if (!vectorOpts.query) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `search_options.vector requires either "value" (embedding) or "query" (text to embed)`
      )
    }

    if (!this.embedder_) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `search_options.vector.query requires an "embedder" function on the postgres search provider options`
      )
    }

    const embedding = await this.embedder_(vectorOpts.query)
    if (embedding.length !== planned.dimensions) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Embedder returned ${embedding.length} dimensions for "${field}", expected ${planned.dimensions}`
      )
    }
    return embedding
  }

  protected async searchKeyword(input: {
    input: SearchTypes.ProviderSearchQuery
    catalog: StoredIndex
    extensions: ExtensionState
    skip: number
    take: number
  }): Promise<{ hitRows: any[]; count: number | null }> {
    const { input: query, catalog, extensions, skip, take } = input
    const plan = catalog.plan
    const options = query.search_options ?? {}
    const filterWhere = toWhereClause(query.filters, plan)
    const q = query.q?.trim()
    const typo = !!(q && options.typo_tolerance)
    const searchOn = options.attributes_to_search_on ?? plan.searchable
    const searchAllFields =
      searchOn.length === plan.searchable.length &&
      searchOn.every((path) => plan.searchable.includes(path))

    if (this.isLakebase_ && q && searchAllFields) {
      await this.ensureBm25Index(catalog.table_name)
    }

    const cte = q ? `WITH q AS (SELECT ?::text AS value)` : ""
    const cteParams = q ? [q] : []
    const conditions: string[] = []
    const whereParams: unknown[] = []

    if (filterWhere?.sql) {
      conditions.push(`(${filterWhere.sql})`)
      whereParams.push(...filterWhere.params)
    }

    let rankSelect = "0::float4 AS score"
    let orderSql: string
    const tsConfig = this.tsConfig_
    const hasScore = !!q

    if (q) {
      const vectorExpr = searchAllFields
        ? `"search_vector"`
        : this.onTheFlyVectorExpr(searchOn, plan)
      const textExpr = searchAllFields
        ? `"search_text"`
        : this.onTheFlyTextExpr(searchOn)

      if (this.isLakebase_ && searchAllFields) {
        const bm25 = bm25IndexName(catalog.table_name)
        // Negative BM25 → negate so higher scores are better (API convention).
        const bm25Score = `-1 * (${vectorExpr} <@> to_bm25query(to_tsvector('${tsConfig}', q.value), '${bm25}'::regclass))`

        if (typo) {
          const sim = similarityCall(extensions, textExpr, "q.value")
          conditions.push(`(
            ${vectorExpr} @@ plainto_tsquery('${tsConfig}', q.value)
            OR ${sim} > 0.3
          )`)
          rankSelect = `GREATEST(${bm25Score}, ${sim}) AS score`
        } else {
          rankSelect = `${bm25Score} AS score`
        }
        orderSql = this.resolveOrderBy(query, plan, true)
      } else if (typo) {
        const sim = similarityCall(extensions, textExpr, "q.value")
        conditions.push(`(
          ${vectorExpr} @@ plainto_tsquery('${tsConfig}', q.value)
          OR ${sim} > 0.3
        )`)
        rankSelect = `GREATEST(
          ts_rank_cd(${vectorExpr}, plainto_tsquery('${tsConfig}', q.value)),
          ${sim}
        ) AS score`
        orderSql = this.resolveOrderBy(query, plan, true)
      } else {
        conditions.push(
          `${vectorExpr} @@ plainto_tsquery('${tsConfig}', q.value)`
        )
        rankSelect = `ts_rank_cd(${vectorExpr}, plainto_tsquery('${tsConfig}', q.value)) AS score`
        orderSql = this.resolveOrderBy(query, plan, true)
      }
    } else {
      orderSql = this.resolveOrderBy(query, plan, false)
    }

    const fromSql = q
      ? `FROM "${catalog.table_name}" CROSS JOIN q`
      : `FROM "${catalog.table_name}"`
    const whereSql = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : ""
    const minScore = options.min_score

    const run = async (manager: DbManager) => {
      if (this.isLakebase_ && q && searchAllFields) {
        await manager.execute(
          `SELECT set_config('lakebase_bm25.default_limit', ?, true)`,
          [String(Math.max(take + skip, take))]
        )
      }

      const baseSelect = `
        ${cte}
        SELECT "id", "document", ${rankSelect}
        ${fromSql}
        ${whereSql}
      `

      let hitsSql: string
      let hitsParams: unknown[]

      if (minScore === undefined) {
        hitsSql = `${baseSelect} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
        hitsParams = [...cteParams, ...whereParams, take, skip]
      } else {
        hitsSql = `
          SELECT * FROM (${baseSelect}) ranked
          WHERE ranked.score >= ?
          ORDER BY ${this.resolveOrderBy(query, plan, hasScore, true)}
          LIMIT ? OFFSET ?
        `
        hitsParams = [...cteParams, ...whereParams, minScore, take, skip]
      }

      const countSql =
        options.count === "none"
          ? null
          : minScore === undefined
          ? `${cte} SELECT COUNT(*)::int AS count ${fromSql} ${whereSql}`
          : `
            SELECT COUNT(*)::int AS count FROM (
              ${cte} SELECT ${rankSelect} ${fromSql} ${whereSql}
            ) ranked WHERE ranked.score >= ?
          `

      const countParams =
        minScore === undefined
          ? [...cteParams, ...whereParams]
          : [...cteParams, ...whereParams, minScore]

      const hitRows = await manager.execute(hitsSql, hitsParams)
      const countRows = countSql
        ? await manager.execute(countSql, countParams)
        : [{ count: null }]

      return {
        hitRows,
        count:
          options.count === "none" ? null : Number(countRows[0]?.count ?? 0),
      }
    }

    return await this.withTransaction(run)
  }

  protected async searchVector(input: {
    input: SearchTypes.ProviderSearchQuery
    catalog: StoredIndex
    queryEmbedding: number[]
    skip: number
    take: number
  }): Promise<{ hitRows: any[]; count: number | null }> {
    const { input: query, catalog, queryEmbedding, skip, take } = input
    const field = query.search_options?.vector?.field
    if (!field) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `search_options.vector.field is required for vector search`
      )
    }

    const col = vectorColumnName(field)
    const op = vectorDistanceOperator(this.vectorDistance_)
    const filterWhere = toWhereClause(query.filters, catalog.plan)
    const embeddingLiteral = `[${queryEmbedding.join(",")}]`

    const conditions: string[] = [`"${col}" IS NOT NULL`]
    const params: unknown[] = []

    if (filterWhere?.sql) {
      conditions.push(`(${filterWhere.sql})`)
      params.push(...filterWhere.params)
    }

    const whereSql = `WHERE ${conditions.join(" AND ")}`
    // Distance → relevance (higher is better).
    const rankSelect = `(1.0 / (1.0 + ("${col}" ${op} ?::vector))) AS score`

    const hitsSql = `
      SELECT "id", "document", ${rankSelect}
      FROM "${catalog.table_name}"
      ${whereSql}
      ORDER BY "${col}" ${op} ?::vector ASC, "id" ASC
      LIMIT ? OFFSET ?
    `

    const hitRows = await this.manager_.execute(hitsSql, [
      embeddingLiteral,
      ...params,
      embeddingLiteral,
      take,
      skip,
    ])

    const countRows =
      query.search_options?.count === "none"
        ? [{ count: null }]
        : await this.manager_.execute(
            `SELECT COUNT(*)::int AS count FROM "${catalog.table_name}" ${whereSql}`,
            params
          )

    return {
      hitRows,
      count:
        query.search_options?.count === "none"
          ? null
          : Number(countRows[0]?.count ?? 0),
    }
  }

  protected async searchHybrid(input: {
    input: SearchTypes.ProviderSearchQuery
    catalog: StoredIndex
    extensions: ExtensionState
    queryEmbedding: number[]
    semanticRatio: number
    skip: number
    take: number
  }): Promise<{ hitRows: any[]; count: number | null }> {
    // Reciprocal Rank Fusion over keyword + vector candidate lists.
    const candidateLimit = Math.max(input.take + input.skip, 40) * 2
    const keyword = await this.searchKeyword({
      ...input,
      skip: 0,
      take: candidateLimit,
    })
    const vector = await this.searchVector({
      ...input,
      skip: 0,
      take: candidateLimit,
    })

    const k = 60
    const keywordWeight = 1 - input.semanticRatio
    const vectorWeight = input.semanticRatio
    const scores = new Map<
      string,
      { id: string; document: unknown; score: number }
    >()

    keyword.hitRows.forEach((row, rank) => {
      const rrf = keywordWeight * (1 / (k + rank + 1))
      scores.set(row.id, {
        id: row.id,
        document: row.document,
        score: rrf,
      })
    })

    vector.hitRows.forEach((row, rank) => {
      const rrf = vectorWeight * (1 / (k + rank + 1))
      const existing = scores.get(row.id)
      if (existing) {
        existing.score += rrf
      } else {
        scores.set(row.id, {
          id: row.id,
          document: row.document,
          score: rrf,
        })
      }
    })

    const ranked = [...scores.values()].sort((a, b) => b.score - a.score)
    const page = ranked.slice(input.skip, input.skip + input.take)

    return {
      hitRows: page,
      count:
        input.input.search_options?.count === "none" ? null : ranked.length,
    }
  }

  async searchMany(
    inputs: SearchTypes.ProviderSearchQuery[]
  ): Promise<SearchTypes.SearchResult[]> {
    return await Promise.all(inputs.map((input) => this.search(input)))
  }

  protected async resolveFacets(input: {
    table: string
    plan: IndexPlan
    filterWhere?: { sql: string; params: unknown[] }
    requests?: (string | SearchTypes.SearchFacetRequest)[]
  }): Promise<Record<string, SearchTypes.SearchFacetResult> | undefined> {
    const requests = normalizeFacetRequests(input.requests, input.plan)
    if (!requests.length) {
      return undefined
    }

    const result: Record<string, SearchTypes.SearchFacetResult> = {}

    for (const request of requests) {
      const query = buildFacetQuery({
        table: input.table,
        whereSql: input.filterWhere?.sql,
        whereParams: input.filterWhere?.params ?? [],
        request,
        plan: input.plan,
      })
      const rows = await this.manager_.execute(query.sql, query.params)
      result[request.field] = mapFacetResult(request, rows)
    }

    return result
  }

  protected onTheFlyTextExpr(paths: string[]): string {
    if (!paths.length) {
      return `''`
    }

    return paths
      .map((path) => {
        const jsonPath = `'{${path.split(".").join(",")}}'`
        return `coalesce(indexed#>>${jsonPath}, '')`
      })
      .join(` || ' ' || `)
  }

  protected onTheFlyVectorExpr(paths: string[], plan: IndexPlan): string {
    if (!paths.length) {
      return `''::tsvector`
    }

    return paths
      .map((path) => {
        const planned = plan.fields.get(path)
        const weight = planned ? weightLabel(planned.field.searchable) : "D"
        const jsonPath = `'{${path.split(".").join(",")}}'`
        return `setweight(to_tsvector('${this.tsConfig_}', coalesce(indexed#>>${jsonPath}, '')), '${weight}')`
      })
      .join(" || ")
  }

  protected resolveOrderBy(
    input: SearchTypes.ProviderSearchQuery,
    plan: IndexPlan,
    hasScore: boolean,
    outerAlias = false
  ): string {
    const order = Object.entries(input.pagination?.order ?? {})
    const scoreRef = outerAlias ? `ranked.score` : `score`
    const idRef = outerAlias ? `ranked.id` : `"id"`

    if (!order.length) {
      return hasScore
        ? `${scoreRef} DESC NULLS LAST, ${idRef} ASC`
        : `${idRef} ASC`
    }

    const clauses: string[] = []

    for (const [property, direction] of order) {
      const dir = direction === "ASC" ? "ASC" : "DESC"

      if (property === "_score") {
        clauses.push(`${scoreRef} ${dir} NULLS LAST`)
        continue
      }

      if (outerAlias) {
        clauses.push(`${idRef} ${dir}`)
        continue
      }

      const planned = plan.fields.get(property)
      if (!planned) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `Cannot sort search index "${input.index.name}" by unknown field "${property}"`
        )
      }

      if (planned.is_array || planned.kind === "vector") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `The postgres search provider cannot sort by "${property}"`
        )
      }

      const jsonPath = `'{${property.split(".").join(",")}}'`

      if (planned.kind === "number") {
        clauses.push(`(indexed#>>${jsonPath})::float8 ${dir} NULLS LAST`)
      } else if (planned.kind === "boolean") {
        clauses.push(`(indexed#>>${jsonPath})::boolean ${dir} NULLS LAST`)
      } else {
        clauses.push(`indexed#>>${jsonPath} ${dir} NULLS LAST`)
      }
    }

    return clauses.join(", ")
  }

  protected async retrieve(index: string): Promise<StoredIndex> {
    const catalog = await this.getCatalog(index)

    if (!catalog) {
      const known = await this.listIndexes()
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `The postgres search provider has no index "${index}". Known indexes: ${
          known.map((entry) => entry.name).join(", ") || "(none)"
        }`
      )
    }

    return catalog
  }

  protected task(index: string): SearchTypes.SearchTask {
    return { index, status: "succeeded" }
  }
}
