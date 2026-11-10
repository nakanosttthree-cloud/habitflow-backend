
require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function initializeDatabase() {
  let connection;

  try {
    // Đọc chứng chỉ CA của Aiven để xác thực kết nối TLS.
    const caPath = path.join(__dirname, 'ca.pem');
    const ca = fs.readFileSync(caPath, 'utf8');

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: {
        ca,
        rejectUnauthorized: true
      },
      connectTimeout: 15000
    });

    console.log('Da ket noi den MySQL.');

    // 1. Bảng công việc
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        due_date DATE,
        priority ENUM('low', 'medium', 'high')
          NOT NULL DEFAULT 'medium',
        is_completed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 2. Bảng thói quen
    await connection.query(`
      CREATE TABLE IF NOT EXISTS habits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        frequency_type ENUM('daily', 'weekly')
          NOT NULL DEFAULT 'daily',
        target_per_week TINYINT UNSIGNED
          NOT NULL DEFAULT 7,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // 3. Bảng ghi nhận ngày hoàn thành thói quen
    await connection.query(`
      CREATE TABLE IF NOT EXISTS habit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        habit_id INT NOT NULL,
        completed_date DATE NOT NULL,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT fk_habit_logs_habit
          FOREIGN KEY (habit_id)
          REFERENCES habits(id)
          ON DELETE CASCADE,

        CONSTRAINT uq_habit_completed_date
          UNIQUE (habit_id, completed_date)
      )
    `);

    console.log('Tao bang tasks: thanh cong.');
    console.log('Tao bang habits: thanh cong.');
    console.log('Tao bang habit_logs: thanh cong.');
    console.log('Khoi tao database HabitFlow hoan tat.');

  } catch (error) {
    console.error('Loi khoi tao database:', error.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

initializeDatabase();
