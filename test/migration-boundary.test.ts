import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { MIGRATION_CHECKSUMS } from "../src/storage/migration-checksums.js";

it("only the explicit migrator imports frozen DDL and its checksums stay immutable", () => {
 assert.deepEqual(MIGRATIONS.map(sql=>createHash("sha256").update(sql).digest("hex")),[...MIGRATION_CHECKSUMS]);
 const walk=(dir:string):void=>{
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const path=join(dir,entry.name);
   if(entry.isDirectory()){walk(path);continue;}
   if(!path.endsWith('.ts') || ['src/storage/schema.ts','src/paper/schema.ts','src/storage/migrations.ts'].includes(path))continue;
   const text=readFileSync(path,'utf8');
   assert(!/import[\s\S]*?\{[^}]*\b(?:SCHEMA_SQL|PAPER_SCHEMA_SQL)\b[^}]*\}/.test(text),`Worker imports DDL: ${path}`);
   assert(!/\.migrate\(/.test(text),`Worker invokes migration: ${path}`);
  }
 };
 walk('src');
});
