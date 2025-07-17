const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",          // ✅ Change if you're using a different MySQL username
  password: "IKMpw@ni1",          // ✅ Add your actual MySQL password if you set one
  database: "barabara_system",
});

module.exports = pool;
