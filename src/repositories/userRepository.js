/**
 * Every read and write of the users table lives here.
 */

const db = require('../config/db');

async function loadUserRow(id) {
  const [rows] = await db.query(
    'SELECT id, name, email, phone, role, created_at, last_login_at FROM users WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

// The session cookie carries the role it had at login, so admin checks re-read
// the row: a promotion or removal then takes effect on the next request instead

async function countAdmins() {
  const [rows] = await db.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'");
  return Number(rows[0].total) || 0;
}

// --- Auth API ----------------------------------------------------------------

async function findByEmail(email) {
  const [rows] = await db.query(
    'SELECT id, name, email, phone, password_hash, role FROM users WHERE email = ? LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

async function findByPhone(phone) {
  const [rows] = await db.query('SELECT id FROM users WHERE phone = ? LIMIT 1', [phone]);
  return rows[0] || null;
}

async function countUsers() {
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM users');
  return Number(rows[0].total) || 0;
}

async function listUsers() {
  const [rows] = await db.query(
    'SELECT id, name, email, phone, role, created_at, last_login_at FROM users ORDER BY created_at ASC'
  );
  return rows;
}

async function insertUser({ name, email, passwordHash, phone, role }) {
  const [result] = await db.query(
    'INSERT INTO users (name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, phone, role]
  );
  return result.insertId;
}

async function updateRole(id, role) {
  await db.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
}

async function deleteUser(id) {
  await db.query('DELETE FROM users WHERE id = ?', [id]);
}

function touchLastLogin(id) {
  return db
    .query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [id])
    .catch((err) => console.warn('\u26a0\ufe0f Could not record last login:', err.message));
}

module.exports = {
  loadUserRow,
  countAdmins,
  findByEmail,
  findByPhone,
  countUsers,
  listUsers,
  insertUser,
  updateRole,
  deleteUser,
  touchLastLogin,
};
