
require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

async function testConnection() {
  let connection;

  try {
    // Đọc CA certificate của Aiven
    const caPath = path.join(__dirname, 'ca.pem');
    const ca = fs.readFileSync(caPath, 'utf8');

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,

      // Xác minh chứng chỉ máy chủ bằng CA của Aiven
      ssl: {
        ca: ca,
        rejectUnauthorized: true
      },

      connectTimeout: 15000
    });

    const [rows] = await connection.query(
      'SELECT DATABASE() AS databaseName, VERSION() AS mysqlVersion'
    );

    console.log('Ket noi MySQL thanh cong!');
    console.log('Database:', rows[0].databaseName);
    console.log('MySQL version:', rows[0].mysqlVersion);
  } catch (error) {
    console.error('Ket noi that bai:', error.message);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

testConnection();
