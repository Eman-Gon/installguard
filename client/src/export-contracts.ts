import { mkdir, writeFile } from 'node:fs/promises';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RequestSchema, PolicySchema, QuoteSchema, ResultSchema } from './contracts.js';
await mkdir(new URL('../../contracts/',import.meta.url),{recursive:true});
for(const [name,schema] of Object.entries({request:RequestSchema,policy:PolicySchema,quote:QuoteSchema,result:ResultSchema}))await writeFile(new URL(`../../contracts/${name}.schema.json`,import.meta.url),JSON.stringify(zodToJsonSchema(schema,{name}),null,2)+'\n');
