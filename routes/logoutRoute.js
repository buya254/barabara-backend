// routes/logoutRoute.js
const express = require('express');
const router = express.Router();

router.post('/', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Logout failed' });
    }
    res.clearCookie('connect.sid'); // remove session cookie
    res.status(200).json({ message: 'Logged out successfully' });
  });
});

module.exports = router;
