const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Dùng khi không tìm thấy tài khoản, để thời gian phản hồi
// không tiết lộ tên đăng nhập có tồn tại hay không.
const DUMMY_HASH = bcrypt.hashSync('khong-phai-mat-khau-that', 10);

function getSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET chua duoc cau hinh (can it nhat 32 ky tu)'
    );
  }

  return secret;
}

function signToken(user) {
  return jwt.sign(
    { username: user.username },
    getSecret(),
    { subject: String(user.id), expiresIn: '30d' }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    email_verified: Boolean(user.email_verified)
  };
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Middleware: yêu cầu đăng nhập. Gắn req.user = { id, username }.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Cần đăng nhập' });
  }

  try {
    const payload = jwt.verify(token, getSecret());
    req.user = { id: Number(payload.sub), username: payload.username };
    next();
  } catch (error) {
    res.status(401).json({
      message: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn'
    });
  }
}

function createAuthRouter(pool) {
  getSecret(); // Báo lỗi ngay khi khởi động nếu thiếu JWT_SECRET.

  const router = express.Router();

  // Đăng ký tài khoản.
  router.post('/register', async (req, res) => {
    const username = readText(req.body.username).toLowerCase();
    const email = readText(req.body.email).toLowerCase();
    const password =
      typeof req.body.password === 'string' ? req.body.password : '';

    if (!USERNAME_PATTERN.test(username)) {
      return res.status(400).json({
        message:
          'Tên đăng nhập gồm 3 đến 30 ký tự: chữ thường không dấu, số, dấu gạch dưới hoặc dấu chấm'
      });
    }

    if (email.length > 255 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ message: 'Email không hợp lệ' });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        message: 'Mật khẩu phải từ 8 đến 72 ký tự'
      });
    }

    try {
      const hash = await bcrypt.hash(password, 10);

      const [result] = await pool.execute(
        `INSERT INTO users (username, email, password_hash)
         VALUES (?, ?, ?)`,
        [username, email, hash]
      );

      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE id = ?',
        [result.insertId]
      );

      res.status(201).json({
        token: signToken(rows[0]),
        user: publicUser(rows[0])
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          message: 'Tên đăng nhập hoặc email đã được sử dụng'
        });
      }

      console.error('Register error:', error.message);
      res.status(500).json({ message: 'Không tạo được tài khoản' });
    }
  });

  // Đăng nhập bằng tên đăng nhập và mật khẩu.
  router.post('/login', async (req, res) => {
    const username = readText(req.body.username).toLowerCase();
    const password =
      typeof req.body.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(400).json({
        message: 'Vui lòng nhập tên đăng nhập và mật khẩu'
      });
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE username = ?',
        [username]
      );
      const user = rows[0];

      const ok = await bcrypt.compare(
        password,
        user ? user.password_hash : DUMMY_HASH
      );

      if (!user || !ok) {
        return res.status(401).json({
          message: 'Sai tên đăng nhập hoặc mật khẩu'
        });
      }

      res.json({ token: signToken(user), user: publicUser(user) });
    } catch (error) {
      console.error('Login error:', error.message);
      res.status(500).json({ message: 'Không đăng nhập được' });
    }
  });

  // Thông tin người đang đăng nhập.
  router.get('/me', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE id = ?',
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(401).json({ message: 'Tài khoản không còn tồn tại' });
      }

      res.json(publicUser(rows[0]));
    } catch (error) {
      console.error('Get me error:', error.message);
      res.status(500).json({ message: 'Không lấy được thông tin tài khoản' });
    }
  });

  return router;
}

module.exports = { createAuthRouter, requireAuth };