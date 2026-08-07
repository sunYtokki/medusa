import {
  assertIndexSupported,
  assertQuerySupported,
  buildIndexPlan,
  extractPrimaryKeyFilter,
  projectIndexedDocument,
  sameSchema,
  tableNameForIndex,
  toWhereClause,
  weightLabel,
} from "../index"
import { SearchTypes } from "@medusajs/framework/types"

const baseDefinition = (
  overrides: Partial<SearchTypes.ResolvedSearchIndexDefinition> = {}
): SearchTypes.ResolvedSearchIndexDefinition =>
  ({
    name: "product",
    entity: "product",
    primary_key: "id",
    provider: "search-postgres",
    physical_name: "product",
    definition_hash: "abc",
    settings: {},
    seed: async function* () {},
    fields: {
      id: { type: "keyword", filterable: true },
      title: { type: "text", searchable: { weight: 3 }, filterable: true },
      status: { type: "keyword", filterable: true, facetable: true },
      price: { type: "float", filterable: true, sortable: true, facetable: true },
      tags: { type: "keyword", array: true, filterable: true, facetable: true },
      variants: {
        type: "object",
        array: true,
        fields: {
          color: { type: "keyword", filterable: true },
        },
      },
    },
    ...overrides,
  }) as SearchTypes.ResolvedSearchIndexDefinition

describe("postgres search utils", () => {
  describe("buildIndexPlan", () => {
    it("flattens nested object arrays into leaf paths", () => {
      const plan = buildIndexPlan(baseDefinition())

      expect(plan.searchable).toEqual(["title"])
      expect(plan.fields.has("variants.color")).toBe(true)
      expect(plan.fields.get("variants.color")?.is_array).toBe(true)
      expect(plan.fields.get("tags")?.is_array).toBe(true)
    })

    it("rejects vector and correlated fields on native", () => {
      expect(() =>
        assertIndexSupported(
          baseDefinition({
            fields: {
              embedding: { type: "vector", dimensions: 3 },
            },
          }),
          "native"
        )
      ).toThrow(/lakebase/)

      expect(() =>
        assertIndexSupported(
          baseDefinition({
            fields: {
              variants: {
                type: "object",
                array: true,
                correlated: true,
                fields: { color: { type: "keyword" } },
              },
            },
          })
        )
      ).toThrow(/correlated/)
    })

    it("allows vector fields on lakebase when dimensions are set", () => {
      expect(() =>
        assertIndexSupported(
          baseDefinition({
            fields: {
              id: { type: "keyword", filterable: true },
              embedding: { type: "vector", dimensions: 1536 },
            },
          }),
          "lakebase"
        )
      ).not.toThrow()
    })
  })

  describe("sameSchema", () => {
    it("matches plans with identical fingerprints", () => {
      const a = buildIndexPlan(baseDefinition())
      const b = buildIndexPlan(baseDefinition())
      expect(sameSchema(a, b)).toBe(true)
    })

    it("differs when searchability changes", () => {
      const a = buildIndexPlan(baseDefinition())
      const b = buildIndexPlan(
        baseDefinition({
          fields: {
            ...baseDefinition().fields,
            title: { type: "text", filterable: true },
          },
        })
      )
      expect(sameSchema(a, b)).toBe(false)
    })
  })

  describe("projectIndexedDocument", () => {
    it("collapses array-of-object leaves and builds weighted text", () => {
      const plan = buildIndexPlan(baseDefinition())
      const projected = projectIndexedDocument(
        {
          id: "prod_1",
          title: "Red shoe",
          status: "published",
          price: 49.99,
          tags: ["sale", "new"],
          variants: [{ color: "red" }, { color: "blue" }],
        },
        plan
      )

      expect(projected.id).toBe("prod_1")
      expect(projected.indexed["variants"]).toEqual({
        color: ["red", "blue"],
      })
      expect(projected.search_text).toContain("Red shoe")
      expect(projected.weighted_parts[0].weight).toBe("A")
    })
  })

  describe("toWhereClause", () => {
    it("compiles $and / $or / $not and comparisons", () => {
      const plan = buildIndexPlan(baseDefinition())
      const where = toWhereClause(
        {
          $and: [
            { status: "published" },
            {
              $or: [{ price: { $gte: 10 } }, { tags: { $overlaps: ["sale"] } }],
            },
            { $not: { status: "draft" } },
          ],
        },
        plan
      )

      expect(where?.sql).toContain("OR")
      expect(where?.sql).toContain("NOT")
      expect(where?.sql).toContain("jsonb_exists_any")
      expect(where?.params).toEqual(
        expect.arrayContaining(["published", 10, ["sale"], "draft"])
      )
    })
  })

  describe("extractPrimaryKeyFilter", () => {
    it("recognises id membership", () => {
      const plan = buildIndexPlan(baseDefinition())
      expect(extractPrimaryKeyFilter({ id: ["a", "b"] }, plan)).toEqual([
        "a",
        "b",
      ])
      expect(
        extractPrimaryKeyFilter({ id: { $in: ["a"] }, status: "x" }, plan)
      ).toBeUndefined()
    })
  })

  describe("helpers", () => {
    it("maps weights and sanitises table names", () => {
      expect(weightLabel({ weight: 3 })).toBe("A")
      expect(weightLabel(true)).toBe("D")
      expect(tableNameForIndex("Product Index")).toBe("search_pg_product_index")
    })

    it("rejects unsupported query options", () => {
      expect(() =>
        assertQuerySupported({
          index: baseDefinition(),
          attributes_to_retrieve: ["id"],
          search_options: { highlight: { fields: ["title"] } },
        })
      ).toThrow(/highlight/)

      expect(() =>
        assertQuerySupported(
          {
            index: baseDefinition(),
            attributes_to_retrieve: ["id"],
            search_options: {
              vector: { field: "embedding", value: [0.1, 0.2] },
            },
          },
          "native"
        )
      ).toThrow(/lakebase/)
    })
  })
})
