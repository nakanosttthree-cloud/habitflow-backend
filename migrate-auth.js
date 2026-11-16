require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS n
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].n > 0;
}

async function migrate() {
  let connection;

  try {
    const ca = fs.readFileSync(path.join(__dirname, 'ca.pem'), 'utf8');

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: { ca, rejectUnauthorized: true },
      connectTimeout: 15000
    });

    console.log('Da ket noi den MySQL.');

    // 1. Bảng người dùng
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(30) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT uq_users_username UNIQUE (username),
        CONSTRAINT uq_users_email UNIQUE (email)
      )
    `);
    console.log('Bang users: san sang.');

    // 2. Cột user_id cho habits và tasks
    for (const table of ['habits', 'tasks']) {
      if (await columnExists(connection, table, 'user_id')) {
        console.log(`Bang ${table}: da co cot user_id.`);
        continue;
      }

      await connection.query(`
        ALTER TABLE ${table}
          ADD COLUMN user_id INT NULL AFTER id,
          ADD CONSTRAINT fk_${table}_user
            FOREIGN KEY (user_id) REFERENCES users(id)
            ON DELETE CASCADE
      `);
      console.log(`Bang ${table}: da them cot user_id.`);
    }

    console.log('Hoan tat.');
  } catch (error) {
    console.error('Loi migrate:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

migrate();