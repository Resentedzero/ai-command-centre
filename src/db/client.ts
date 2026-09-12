/**
 * Drizzle client wired to `DATABASE_URL`. Loads `.env` via dotenv — never
 * hardcode connection strings here or anywhere else.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export const pool = createPool(requireEnv("DATABASE_URL"));

export const db = drizzle(pool, { schema });

export type Database = typeof db;
