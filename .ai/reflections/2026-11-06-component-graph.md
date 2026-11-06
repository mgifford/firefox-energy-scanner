# 2026-11-06 — component graph (component attribution, PR A)

**Task:** A canonical component graph with stable types and instances, owned counts,
page-level resources and an evidence contract; migrate older results.

**Changed:** `src/collect/page-anatomy.ts` (owned counts), `src/model/{graph,schema,migrate}.ts` (new),
`src/analysis/{components,investigation,remediation}.ts`, `src/report/{resources-html,resources-csv,components-html,html}.ts`,
`src/cli/index.ts`, `schema/component-graph.schema.json`, fixture site and e2e, docs.

**Evidence:** owned counts sum exactly to `<body>` (374 = 374) in Chromium; the
Energy.gov v1 result migrates, validates, marks the wrapper and header as containers, and
puts the FontAwesome library (3.5 MB on 47/47 pages) first; the fixture site gives one
navigation type with an instance per page. `npm test`.

**Worked:** analysing the stored Energy.gov resources before designing: the shared
icon library and the home page's unique images were in the data all along.

**Cost time:** analytics beacons with kilobytes of query became hundreds of
"page-unique resources" until identified by endpoint.

**Next:** PR B, resource-level Lighthouse findings and optional Chromium tracing.
