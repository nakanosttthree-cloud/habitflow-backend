const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { sendCodeEmail } = require('./mailer');

const USERNAME_PATTERN = /^[a-z0-9_.]{3,30}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;

const CODE_MINUTES = 15;    // mã có hiệu lực bao lâu
const MAX_ATTEMPTS = 5;     // số lần nhập sai tối đa cho một mã
const RESEND_SECONDS = 60;  // khoảng cách tối thiểu giữa hai lần gửi mã

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

function isValidPassword(password) {
  return password.length >= 8 && password.length <= 72;
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Băm mã để không lưu mã gốc trong database.
function hashCode(userId, purpose, code) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${userId}:${purpose}:${code}`)
    .digest('hex');
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

  // Tạo mã mới và gửi email. Trả về 'sent' hoặc 'too_soon'.
  async function issueCode(user, purpose) {
    const [recent] = await pool.query(
      `SELECT id FROM email_codes
       WHERE user_id = ? AND purpose = ?
         AND created_at > DATE_SUB(UTC_TIMESTAMP(),
                                   INTERVAL ${RESEND_SECONDS} SECOND)
       LIMIT 1`,
      [user.id, purpose]
    );

    if (recent.length > 0) {
      return 'too_soon';
    }

    // Mã cũ chưa dùng không còn hiệu lực.
    await pool.execute(
      `UPDATE email_codes SET used_at = UTC_TIMESTAMP()
       WHERE user_id = ? AND purpose = ? AND used_at IS NULL`,
      [user.id, purpose]
    );

    const code = generateCode();

    const [result] = await pool.query(
      `INSERT INTO email_codes (user_id, purpose, code_hash, expires_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(),
                                 INTERVAL ${CODE_MINUTES} MINUTE))`,
      [user.id, purpose, hashCode(user.id, purpose, code)]
    );

    try {
      await sendCodeEmail(user.email, purpose, code, CODE_MINUTES);
    } catch (error) {
      // Gửi lỗi thì bỏ mã vừa tạo để người dùng yêu cầu lại được ngay.
      await pool.execute(
        'DELETE FROM email_codes WHERE id = ?',
        [result.insertId]
      );
      throw error;
    }

    return 'sent';
  }

  // Kiểm tra mã. Đúng thì đánh dấu đã dùng và trả về true.
  async function checkCode(user, purpose, code) {
    const [rows] = await pool.execute(
      `SELECT id, code_hash, attempts FROM email_codes
       WHERE user_id = ? AND purpose = ?
         AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
       ORDER BY id DESC
       LIMIT 1`,
      [user.id, purpose]
    );

    const row = rows[0];

    if (!row || row.attempts >= MAX_ATTEMPTS) {
      return false;
    }

    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(user.id, purpose, code), 'hex');
    const match =
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual);

    if (!match) {
      await pool.execute(
        'UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?',
        [row.id]
      );
      return false;
    }

    await pool.execute(
      'UPDATE email_codes SET used_at = UTC_TIMESTAMP() WHERE id = ?',
      [row.id]
    );

    return true;
  }

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

    if (!isValidPassword(password)) {
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
      const user = rows[0];

      // Gửi mã xác thực email; lỗi gửi không làm hỏng việc đăng ký.
      try {
        await issueCode(user, 'verify');
      } catch (mailError) {
        console.error('Send verification error:', mailError.message);
      }

      res.status(201).json({
        token: signToken(user),
        user: publicUser(user)
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

  // Gửi (lại) mã xác thực email cho người đang đăng nhập.
  router.post('/send-verification', requireAuth, async (req, res) => {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE id = ?',
        [req.user.id]
      );
      const user = rows[0];

      if (!user) {
        return res.status(401).json({ message: 'Tài khoản không còn tồn tại' });
      }

      if (user.email_verified) {
        return res.json({ message: 'Email đã được xác thực' });
      }

      const status = await issueCode(user, 'verify');

      if (status === 'too_soon') {
        return res.status(429).json({
          message: `Vui lòng đợi ${RESEND_SECONDS} giây trước khi yêu cầu mã mới`
        });
      }

      res.json({ message: 'Đã gửi mã xác thực tới email của bạn' });
    } catch (error) {
      console.error('Send verification error:', error.message);
      res.status(500).json({ message: 'Không gửi được email xác thực' });
    }
  });

  // Xác thực email bằng mã 6 số.
  router.post('/verify-email', requireAuth, async (req, res) => {
    const code = readText(req.body.code);

    if (!CODE_PATTERN.test(code)) {
      return res.status(400).json({ message: 'Mã gồm 6 chữ số' });
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE id = ?',
        [req.user.id]
      );
      const user = rows[0];

      if (!user) {
        return res.status(401).json({ message: 'Tài khoản không còn tồn tại' });
      }

      if (user.email_verified) {
        return res.json(publicUser(user));
      }

      if (!(await checkCode(user, 'verify', code))) {
        return res.status(400).json({
          message: 'Mã không đúng hoặc đã hết hạn'
        });
      }

      await pool.execute(
        'UPDATE users SET email_verified = 1 WHERE id = ?',
        [user.id]
      );
      user.email_verified = 1;

      res.json(publicUser(user));
    } catch (error) {
      console.error('Verify email error:', error.message);
      res.status(500).json({ message: 'Không xác thực được email' });
    }
  });

  // Quên mật khẩu: gửi mã tới email (chỉ khi email đã xác thực).
  // Luôn trả lời giống nhau để không lộ tài khoản nào tồn tại.
  router.post('/forgot-password', async (req, res) => {
    const identifier = readText(req.body.identifier).toLowerCase();

    const reply = () => res.json({
      message:
        'Nếu tài khoản tồn tại và email đã được xác thực, mã đặt lại mật khẩu đã được gửi.'
    });

    if (!identifier) {
      return res.status(400).json({
        message: 'Vui lòng nhập tên đăng nhập hoặc email'
      });
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
        [identifier, identifier]
      );
      const user = rows[0];

      if (user && user.email_verified) {
        try {
          await issueCode(user, 'reset');
        } catch (mailError) {
          console.error('Send reset code error:', mailError.message);
        }
      }

      reply();
    } catch (error) {
      console.error('Forgot password error:', error.message);
      res.status(500).json({ message: 'Không xử lý được yêu cầu' });
    }
  });

  // Đặt lại mật khẩu bằng mã nhận qua email.
  router.post('/reset-password', async (req, res) => {
    const identifier = readText(req.body.identifier).toLowerCase();
    const code = readText(req.body.code);
    const newPassword =
      typeof req.body.new_password === 'string' ? req.body.new_password : '';

    if (!identifier || !CODE_PATTERN.test(code)) {
      return res.status(400).json({
        message: 'Mã không đúng hoặc đã hết hạn'
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        message: 'Mật khẩu phải từ 8 đến 72 ký tự'
      });
    }

    try {
      const [rows] = await pool.execute(
        'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
        [identifier, identifier]
      );
      const user = rows[0];

      if (!user || !(await checkCode(user, 'reset', code))) {
        return res.status(400).json({
          message: 'Mã không đúng hoặc đã hết hạn'
        });
      }

      const hash = await bcrypt.hash(newPassword, 10);

      await pool.execute(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [hash, user.id]
      );

      res.json({ message: 'Đã đổi mật khẩu. Hãy đăng nhập lại.' });
    } catch (error) {
      console.error('Reset password error:', error.message);
      res.status(500).json({ message: 'Không đổi được mật khẩu' });
    }
  });

  return router;
}

module.exports = { createAuthRouter, requireAuth };