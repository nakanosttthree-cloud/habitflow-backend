
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Android HttpURLConnection không có PATCH: cho phép POST + header override.
app.use((req, res, next) => {
  if (
    req.method === 'POST' &&
    req.headers['x-http-method-override'] === 'PATCH'
  ) {
    req.method = 'PATCH';
  }
  next();
});

// Kết nối MySQL bằng TLS và xác thực chứng chỉ CA của Aiven.
const ca = fs.readFileSync(
  path.join(__dirname, 'ca.pem'),
  'utf8'
);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    ca,
    rejectUnauthorized: true
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Kiểm tra API và kết nối database.
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      status: 'ok',
      database: 'connected',
      app: 'HabitFlow API'
    });
  } catch (error) {
    console.error('Health check error:', error.message);

    res.status(503).json({
      status: 'error',
      message: 'Database connection failed'
    });
  }
});

// Lấy danh sách công việc.
app.get('/api/tasks', async (req, res) => {
  try {
    const [tasks] = await pool.query(
      'SELECT * FROM tasks ORDER BY created_at DESC'
    );

    res.json(tasks);
  } catch (error) {
    console.error('Get tasks error:', error.message);
    res.status(500).json({ message: 'Cannot retrieve tasks' });
  }
});

// Lấy thông tin một công việc.
app.get('/api/tasks/:id', async (req, res) => {
  try {
    const [tasks] = await pool.execute(
      'SELECT * FROM tasks WHERE id = ?',
      [req.params.id]
    );

    if (tasks.length === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json(tasks[0]);
  } catch (error) {
    console.error('Get task error:', error.message);
    res.status(500).json({ message: 'Cannot retrieve task' });
  }
});

// Tạo công việc mới.
app.post('/api/tasks', async (req, res) => {
  const { title, description, due_date, priority } = req.body;

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({
      message: 'Title is required'
    });
  }

  if (
    priority !== undefined &&
    !['low', 'medium', 'high'].includes(priority)
  ) {
    return res.status(400).json({
      message: 'Priority must be low, medium or high'
    });
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO tasks (title, description, due_date, priority)
       VALUES (?, ?, ?, ?)`,
      [
        title.trim(),
        description ?? null,
        due_date || null,
        priority || 'medium'
      ]
    );

    const [tasks] = await pool.execute(
      'SELECT * FROM tasks WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(tasks[0]);
  } catch (error) {
    console.error('Create task error:', error.message);
    res.status(500).json({ message: 'Cannot create task' });
  }
});

// Cập nhật công việc.
app.put('/api/tasks/:id', async (req, res) => {
  const { title, description, due_date, priority, is_completed } = req.body;

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({
      message: 'Title is required'
    });
  }

  if (
    priority !== undefined &&
    !['low', 'medium', 'high'].includes(priority)
  ) {
    return res.status(400).json({
      message: 'Invalid priority'
    });
  }

  if (
    is_completed !== undefined &&
    typeof is_completed !== 'boolean' &&
    is_completed !== 0 &&
    is_completed !== 1
  ) {
    return res.status(400).json({
      message: 'is_completed must be boolean'
    });
  }

  try {
    const [result] = await pool.execute(
      `UPDATE tasks
       SET title = ?, description = ?, due_date = ?,
           priority = ?, is_completed = ?
       WHERE id = ?`,
      [
        title.trim(),
        description ?? null,
        due_date || null,
        priority || 'medium',
        is_completed === undefined ? 0 : Number(is_completed),
        req.params.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const [tasks] = await pool.execute(
      'SELECT * FROM tasks WHERE id = ?',
      [req.params.id]
    );

    res.json(tasks[0]);
  } catch (error) {
    console.error('Update task error:', error.message);
    res.status(500).json({ message: 'Cannot update task' });
  }
});

// Xóa công việc.
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM tasks WHERE id = ?',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Task not found' });
    }

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Delete task error:', error.message);
    res.status(500).json({ message: 'Cannot delete task' });
  }
});

/* ========== HABITS API ========== */

// 1. Lấy danh sách thói quen
// Dùng: GET /api/habits?date=YYYY-MM-DD (ngày hôm nay theo máy người dùng)
app.get('/api/habits', async (req, res) => {
  const today = req.query.date;

  if (today !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return res.status(400).json({
      message: 'date must use YYYY-MM-DD'
    });
  }

  try {
    const [habits] = await pool.execute(
      `SELECT
         h.*,
         COUNT(hl.id) AS completed_days,
         CAST(COALESCE(SUM(hl.completed_date = ?), 0) AS UNSIGNED)
           AS completed_today
       FROM habits h
       LEFT JOIN habit_logs hl ON hl.habit_id = h.id
       GROUP BY h.id
       ORDER BY h.created_at DESC`,
      [today || null]
    );

    res.json(habits);
  } catch (error) {
    console.error('Get habits error:', error.message);
    res.status(500).json({ message: 'Cannot retrieve habits' });
  }
});

// 2. Tạo thói quen
app.post('/api/habits', async (req, res) => {
  const {
    name,
    description,
    frequency_type,
    target_per_week
  } = req.body;

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({
      message: 'Name is required'
    });
  }

  const frequency = frequency_type || 'daily';
  const target = target_per_week === undefined
    ? 7
    : target_per_week;

  if (!['daily', 'weekly'].includes(frequency)) {
    return res.status(400).json({
      message: 'frequency_type must be daily or weekly'
    });
  }

  if (!Number.isInteger(target) || target < 1 || target > 7) {
    return res.status(400).json({
      message: 'target_per_week must be from 1 to 7'
    });
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO habits
       (name, description, frequency_type, target_per_week)
       VALUES (?, ?, ?, ?)`,
      [
        name.trim(),
        description ?? null,
        frequency,
        target
      ]
    );

    const [habits] = await pool.execute(
      'SELECT * FROM habits WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(habits[0]);
  } catch (error) {
    console.error('Create habit error:', error.message);
    res.status(500).json({ message: 'Cannot create habit' });
  }
});

// 3. Cập nhật thông tin hoặc trạng thái thói quen
app.patch('/api/habits/:id', async (req, res) => {
  const { name, description, frequency_type, target_per_week, is_active } = req.body;

  const fields = [];
  const values = [];

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Invalid name' });
    }
    fields.push('name = ?');
    values.push(name.trim());
  }

  if (description !== undefined) {
    if (description !== null && typeof description !== 'string') {
      return res.status(400).json({ message: 'Invalid description' });
    }
    fields.push('description = ?');
    values.push(description);
  }

  if (frequency_type !== undefined) {
    if (!['daily', 'weekly'].includes(frequency_type)) {
      return res.status(400).json({ message: 'Invalid frequency_type' });
    }
    fields.push('frequency_type = ?');
    values.push(frequency_type);
  }

  if (target_per_week !== undefined) {
    if (!Number.isInteger(target_per_week) ||
        target_per_week < 1 || target_per_week > 7) {
      return res.status(400).json({ message: 'Invalid target_per_week' });
    }
    fields.push('target_per_week = ?');
    values.push(target_per_week);
  }

  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean' && is_active !== 0 && is_active !== 1) {
      return res.status(400).json({ message: 'Invalid is_active' });
    }
    fields.push('is_active = ?');
    values.push(Number(is_active));
  }

  if (fields.length === 0) {
    return res.status(400).json({ message: 'No valid fields provided' });
  }

  try {
    values.push(req.params.id);

    const [result] = await pool.execute(
      `UPDATE habits SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    const [habits] = await pool.execute(
      'SELECT * FROM habits WHERE id = ?',
      [req.params.id]
    );

    if (habits.length === 0) {
      return res.status(404).json({ message: 'Habit not found' });
    }

    res.json(habits[0]);
  } catch (error) {
    console.error('Update habit error:', error.message);
    res.status(500).json({ message: 'Cannot update habit' });
  }
});

// 4. Ghi nhận hoàn thành thói quen
app.post('/api/habits/:id/logs', async (req, res) => {
  const { completed_date, note } = req.body;
  const date = completed_date || new Date().toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      message: 'completed_date must use YYYY-MM-DD'
    });
  }

  try {
    const [habits] = await pool.execute(
      'SELECT id FROM habits WHERE id = ?',
      [req.params.id]
    );

    if (habits.length === 0) {
      return res.status(404).json({ message: 'Habit not found' });
    }

    const [result] = await pool.execute(
      `INSERT INTO habit_logs (habit_id, completed_date, note)
       VALUES (?, ?, ?)`,
      [req.params.id, date, note ?? null]
    );

    const [logs] = await pool.execute(
      'SELECT * FROM habit_logs WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(logs[0]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'Habit already completed on this date'
      });
    }

    console.error('Create habit log error:', error.message);
    res.status(500).json({ message: 'Cannot record habit completion' });
  }
});

// 5. Xem lịch sử hoàn thành
app.get('/api/habits/:id/logs', async (req, res) => {
  try {
    const [logs] = await pool.execute(
      `SELECT * FROM habit_logs
       WHERE habit_id = ?
       ORDER BY completed_date DESC`,
      [req.params.id]
    );

    res.json(logs);
  } catch (error) {
    console.error('Get habit logs error:', error.message);
    res.status(500).json({ message: 'Cannot retrieve habit logs' });
  }
});

// 6. Xóa thói quen
app.delete('/api/habits/:id', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM habits WHERE id = ?',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Habit not found' });
    }

    res.json({ message: 'Habit deleted successfully' });
  } catch (error) {
    console.error('Delete habit error:', error.message);
    res.status(500).json({ message: 'Cannot delete habit' });
  }
});
/* ========== STATS API ========== */

// Cộng (hoặc trừ) số ngày vào một ngày dạng YYYY-MM-DD.
function addDays(dateStr, days) {
  const ms = Date.parse(dateStr + 'T00:00:00Z') + days * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Thống kê tiến độ.
// Dùng: GET /api/stats?date=YYYY-MM-DD (ngày hôm nay theo máy người dùng)
app.get('/api/stats', async (req, res) => {
  const today = req.query.date;

  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return res.status(400).json({
      message: 'date must use YYYY-MM-DD'
    });
  }

  try {
    const [habits] = await pool.query(
      `SELECT id, name, target_per_week
       FROM habits
       WHERE is_active = 1
       ORDER BY created_at DESC`
    );

    const [logs] = await pool.execute(
      `SELECT habit_id, DATE_FORMAT(completed_date, '%Y-%m-%d') AS d
       FROM habit_logs
       WHERE completed_date <= ?`,
      [today]
    );

    // Gom các ngày đã hoàn thành theo từng thói quen.
    const doneByHabit = new Map();
    for (const log of logs) {
      if (!doneByHabit.has(log.habit_id)) {
        doneByHabit.set(log.habit_id, new Set());
      }
      doneByHabit.get(log.habit_id).add(log.d);
    }

    // Ngày đầu tuần (thứ Hai) của tuần chứa "today".
    const dayOfWeek = new Date(Date.parse(today + 'T00:00:00Z'))
      .getUTCDay(); // 0 = Chủ nhật
    const weekStart = addDays(today, -((dayOfWeek + 6) % 7));

    let weekDone = 0;
    let weekTarget = 0;
    let bestStreak = 0;

    const result = habits.map((habit) => {
      const days = doneByHabit.get(habit.id) || new Set();

      // 7 ngày của tuần này, từ thứ Hai đến Chủ nhật.
      const week = [];
      let weekCount = 0;
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const done = days.has(date);
        if (done) weekCount++;
        week.push({ date, done, future: date > today });
      }

      // Chuỗi ngày liên tiếp: không đứt nếu hôm nay chưa hoàn thành.
      let cursor = days.has(today) ? today : addDays(today, -1);
      let streak = 0;
      while (days.has(cursor)) {
        streak++;
        cursor = addDays(cursor, -1);
      }

      weekDone += Math.min(weekCount, habit.target_per_week);
      weekTarget += habit.target_per_week;
      bestStreak = Math.max(bestStreak, streak);

      return {
        id: habit.id,
        name: habit.name,
        target_per_week: habit.target_per_week,
        week_count: weekCount,
        streak,
        week
      };
    });

    res.json({
      summary: {
        week_done: weekDone,
        week_target: weekTarget,
        best_streak: bestStreak
      },
      habits: result
    });
  } catch (error) {
    console.error('Get stats error:', error.message);
    res.status(500).json({ message: 'Cannot retrieve stats' });
  }
});
app.listen(PORT, '0.0.0.0', () => {
  console.log(`HabitFlow API running at http://localhost:${PORT}`);
});
