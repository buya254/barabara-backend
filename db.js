const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST|| "localhost",
  user: process.env.DB_USER|| "root",          // ✅ Change if you're using a different MySQL username
  password: process.env.DB_PASS|| "IKMpw@ni1",          // ✅ Add your actual MySQL password if you set one
  database: process.env.DB_NAME|| "barabara_system",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 100,
});

(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Database connected successfully');
  } catch (err) {
    console.error('❌ Database connection failed:', err);
  }
})();

module.exports = pool ;
