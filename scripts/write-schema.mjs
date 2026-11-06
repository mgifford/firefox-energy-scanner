// Writes schema/component-graph.schema.json from the zod schema (npm run schema).
import { writeFileSync } from 'node:fs';
import { graphJsonSchema } from '../dist/model/schema.js';

writeFileSync(new URL('../schema/component-graph.schema.json', import.meta.url), JSON.stringify(graphJsonSchema(), null, 2) + '\n');
console.log('Wrote schema/component-graph.schema.json');
