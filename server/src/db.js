// 数据库连接池
const { Pool } = require('pg');
require('dotenv').config();

// 云平台（Zeabur 等）通常只提供单个 DATABASE_URL；
// 本地 / NAS 部署仍沿用原来的 DB_HOST 等 5 个变量，两者兼容。
const connection = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'testdb',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };

const pool = new Pool({
  ...connection,
  max: 10,                       // 连接池最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('数据库连接池异常:', err.message);
});

module.exports = pool;
