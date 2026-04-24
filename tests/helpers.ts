import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../src/db/schema.js";
import { Repository } from "../src/db/repository.js";

export function freshRepo(): { repo: Repository; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return { repo: new Repository(db), db };
}
