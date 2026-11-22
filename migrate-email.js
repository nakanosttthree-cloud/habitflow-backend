require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

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

    // Mã xác thực email và mã đặt lại mật khẩu (mọi mốc thời gian theo UTC).
    await connection.query(`
      CREATE TABLE IF NOT EXISTS email_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        purpose ENUM('verify', 'reset') NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
        used_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),

        INDEX idx_email_codes_lookup (user_id, purpose),
        CONSTRAINT fk_email_codes_user
          FOREIGN KEY (user_id) REFERENCES users(id)
          ON DELETE CASCADE
      )
    `);

    console.log('Bang email_codes: san sang.');
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