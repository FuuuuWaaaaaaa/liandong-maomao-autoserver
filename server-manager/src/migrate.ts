import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';

const config = loadConfig();
if (config.storageMode !== 'mysql' || !config.databaseUrl) throw new Error('迁移必须使用 STORAGE_MODE=mysql 与 DATABASE_URL');
const pool = mysql.createPool(config.databaseUrl);
const sql = await readFile(join(process.cwd(), 'src/db/migrations/001_initial.sql'), 'utf8');
for (const statement of sql.split(';').map((item) => item.trim()).filter(Boolean)) await pool.query(statement);
await pool.end();
console.log('数据库迁移完成');
