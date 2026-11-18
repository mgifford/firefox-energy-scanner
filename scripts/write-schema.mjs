// Writes the published JSON Schemas from the zod schemas (npm run schema).
import { writeFileSync } from 'node:fs';
import { graphJsonSchema } from '../dist/model/schema.js';
import { findingJsonSchema, timelineJsonSchema } from '../dist/model/records-schema.js';
import { accessibilityJoinJsonSchema } from '../dist/model/accessibility-join.js';
import { candidateQueueJsonSchema } from '../dist/model/candidate-queue.js';

const write = (name, schema) => {
  writeFileSync(new URL(`../schema/${name}`, import.meta.url), JSON.stringify(schema, null, 2) + '\n');
  console.log(`Wrote schema/${name}`);
};
write('component-graph.schema.json', graphJsonSchema());
write('energy-timeline.schema.json', timelineJsonSchema());
write('energy-finding.schema.json', findingJsonSchema());
write('fes-accessibility-join.schema.json', accessibilityJoinJsonSchema());
write('candidate-queue.schema.json', candidateQueueJsonSchema());
