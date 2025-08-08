// routes/loginRoute.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcrypt'); // If you use hashed passwords
const session = require('express-session');

router.post('/', async (req, res) => {
  const { username, password, role, fy } = req.body;
  const roleTable = `users_${role.toLowerCase()}`;

  try {
    const [rows] = await db.query(`SELECT * FROM ${roleTable} WHERE username = ?`, [username]);

    if (rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    const user = rows[0];

    // Optional: if you're using bcrypt
    // const passwordMatch = await bcrypt.compare(password, user.password);
    const passwordMatch = user.password === password;

    if (!passwordMatch) {
      return res.status(401).json({ message: 'Incorrect password' });
    }

    // Save session
    req.session.user = {
      id: user.id,
      username: user.username,
      role,
      fy,
    };

    res.status(200).json({ message: 'Login successful', role, fy });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
