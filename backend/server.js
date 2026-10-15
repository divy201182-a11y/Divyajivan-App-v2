const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { initDB, run, get, all, insert } = require('./db');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const session = get('SELECT s.user_id, u.name, u.email, u.phone, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.is_active = 1', [token]);
  if (!session) return res.status(401).json({ error: 'Invalid session' });
  req.user = session;
  next();
}

// --- AUTH ---
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !password || (!email && !phone)) return res.status(400).json({ error: 'Name, password, and email or phone required' });
  const existing = get('SELECT id FROM users WHERE email = ? OR phone = ?', [email || '', phone || '']);
  if (existing) return res.status(409).json({ error: 'Account already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const userId = insert('INSERT INTO users (name, email, phone, password_hash) VALUES (?, ?, ?, ?)', [name, email || null, phone || null, hash]);
  const token = uuidv4();
  insert('INSERT INTO sessions (user_id, token) VALUES (?, ?)', [userId, token]);
  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [userId]);
  insert('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, 'register', 'New account created']);
  res.json({ token, user: { id: userId, name, email, phone, role: 'patient' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, phone, password } = req.body;
  if (!password || (!email && !phone)) return res.status(400).json({ error: 'Email/phone and password required' });
  const user = get('SELECT * FROM users WHERE email = ? OR phone = ?', [email || '', phone || '']);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = uuidv4();
  insert('INSERT INTO sessions (user_id, token) VALUES (?, ?)', [user.id, token]);
  run('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
  insert('INSERT INTO activity_log (user_id, action) VALUES (?, ?)', [user.id, 'login']);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } });
});

app.post('/api/auth/logout', authenticate, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  run('UPDATE sessions SET is_active = 0 WHERE token = ?', [token]);
  insert('INSERT INTO activity_log (user_id, action) VALUES (?, ?)', [req.user.user_id, 'logout']);
  res.json({ ok: true });
});

app.get('/api/auth/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// --- APPOINTMENTS ---
app.get('/api/appointments', authenticate, (req, res) => {
  res.json(all('SELECT * FROM appointments WHERE user_id = ? ORDER BY date DESC, time DESC', [req.user.user_id]));
});

app.post('/api/appointments', authenticate, (req, res) => {
  const { doctor_name, specialty, date, time, type, notes } = req.body;
  if (!doctor_name || !date || !time) return res.status(400).json({ error: 'Doctor, date, and time required' });
  const id = insert('INSERT INTO appointments (user_id, doctor_name, specialty, date, time, type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.user.user_id, doctor_name, specialty || null, date, time, type || 'in-person', notes || null]);
  insert('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [req.user.user_id, 'book_appointment', 'With ' + doctor_name + ' on ' + date]);
  res.json({ id, message: 'Appointment booked' });
});

app.patch('/api/appointments/:id', authenticate, (req, res) => {
  const apt = get('SELECT * FROM appointments WHERE id = ? AND user_id = ?', [req.params.id, req.user.user_id]);
  if (!apt) return res.status(404).json({ error: 'Not found' });
  const { status, notes } = req.body;
  if (status) run('UPDATE appointments SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, apt.id]);
  if (notes !== undefined) run('UPDATE appointments SET notes = ?, updated_at = datetime("now") WHERE id = ?', [notes, apt.id]);
  insert('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [req.user.user_id, 'update_appointment', 'ID ' + apt.id + ' → ' + (status || 'updated')]);
  res.json({ ok: true });
});

// --- MEDICINE ORDERS ---
app.get('/api/orders', authenticate, (req, res) => {
  const orders = all('SELECT * FROM medicine_orders WHERE user_id = ? ORDER BY created_at DESC', [req.user.user_id]);
  orders.forEach(o => { o.items = all('SELECT * FROM order_items WHERE order_id = ?', [o.id]); });
  res.json(orders);
});

app.post('/api/orders', authenticate, (req, res) => {
  const { items, delivery_address, payment_method } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ error: 'No items' });
  const orderNum = 'DJ-' + Date.now().toString(36).toUpperCase();
  const total = items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0);
  const orderId = insert('INSERT INTO medicine_orders (user_id, order_number, total_amount, delivery_address, payment_method) VALUES (?, ?, ?, ?, ?)', [req.user.user_id, orderNum, total, delivery_address || null, payment_method || null]);
  items.forEach(i => insert('INSERT INTO order_items (order_id, medicine_name, quantity, price, unit) VALUES (?, ?, ?, ?, ?)', [orderId, i.medicine_name, i.quantity || 1, i.price || 0, i.unit || 'strip']));
  insert('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [req.user.user_id, 'place_order', 'Order ' + orderNum + ', ₹' + total]);
  res.json({ id: orderId, order_number: orderNum, message: 'Order placed' });
});

// --- PRESCRIPTIONS ---
app.get('/api/prescriptions', authenticate, (req, res) => {
  res.json(all('SELECT * FROM prescriptions WHERE user_id = ? ORDER BY date DESC', [req.user.user_id]));
});

app.post('/api/prescriptions', authenticate, (req, res) => {
  const { doctor_name, doctor_reg_no, diagnosis, complaints, date, medicines, vitals, investigations } = req.body;
  const id = insert('INSERT INTO prescriptions (user_id, doctor_name, doctor_reg_no, diagnosis, complaints, date, medicines, vitals, investigations) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.user_id, doctor_name, doctor_reg_no || null, diagnosis || null, complaints || null, date || new Date().toISOString(), JSON.stringify(medicines || []), JSON.stringify(vitals || {}), investigations || null]);
  insert('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [req.user.user_id, 'add_prescription', 'By ' + doctor_name]);
  res.json({ id });
});

// --- REMINDERS ---
app.get('/api/reminders', authenticate, (req, res) => {
  res.json(all('SELECT * FROM medicine_reminders WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC', [req.user.user_id]));
});

app.post('/api/reminders', authenticate, (req, res) => {
  const { medicine_name, dose, frequency, food, times, duration, start_date, end_date } = req.body;
  const id = insert('INSERT INTO medicine_reminders (user_id, medicine_name, dose, frequency, food, times, duration, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.user_id, medicine_name, dose || null, frequency || null, food || null, JSON.stringify(times || []), duration || null, start_date || null, end_date || null]);
  res.json({ id });
});

// --- ADMIN STATS ---
app.get('/api/admin/stats', (req, res) => {
  const users = get('SELECT COUNT(*) as count FROM users')?.count || 0;
  const appointments = get('SELECT COUNT(*) as count FROM appointments')?.count || 0;
  const orders = get('SELECT COUNT(*) as count FROM medicine_orders')?.count || 0;
  const prescriptions = get('SELECT COUNT(*) as count FROM prescriptions')?.count || 0;
  const reminders = get('SELECT COUNT(*) as count FROM medicine_reminders WHERE is_active = 1')?.count || 0;
  const todayLogins = get("SELECT COUNT(*) as count FROM activity_log WHERE action = 'login' AND date(created_at) = date('now')")?.count || 0;
  const recentActivity = all('SELECT a.*, u.name as user_name FROM activity_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 50');
  const recentUsers = all('SELECT id, name, email, phone, role, created_at, last_login, is_active FROM users ORDER BY created_at DESC LIMIT 50');
  const recentAppointments = all('SELECT a.*, u.name as patient_name FROM appointments a JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT 50');
  const recentOrders = all('SELECT o.*, u.name as customer_name FROM medicine_orders o JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT 50');
  recentOrders.forEach(o => { o.items = all('SELECT * FROM order_items WHERE order_id = ?', [o.id]); });
  res.json({ stats: { users, appointments, orders, prescriptions, reminders, todayLogins }, recentActivity, recentUsers, recentAppointments, recentOrders });
});

// --- Serve admin dashboard ---
app.use('/admin', express.static(path.join(__dirname, 'admin')));

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log('');
    console.log('  Divyajivan Backend running on http://localhost:' + PORT);
    console.log('  Admin Dashboard: http://localhost:' + PORT + '/admin');
    console.log('');
  });
}

start();
