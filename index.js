require("dotenv").config();

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const loginRoute = require("./routes/loginRoute");
const logoutRoute = require("./routes/logoutRoute");
const db = require("./db");
const sessionRoute = require('./routes/sessionRoute');

const app = express();

// CORS
app.use(cors({
  origin: "http://localhost:3000", // frontend
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || "yoursecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 3600000,       // 1 hour
    secure: false,         // true if using HTTPS at production stage
    httpOnly: true,        // prevent client-side JS access
    sameSite: 'lax'        // or 'none' with secure: true
  }
}));

// Log session for debugging (move above routes)
app.use((req, res, next) => {
  console.log("🧠 Session info:", req.session);
  next();
});

// Mount routes
app.use("/", loginRoute);

// 🔌 Test DB connection (before starting server)
(async () => {
  try {
    await db.query("SELECT 1");
    console.log("✅ Database connected successfully");
  } catch (err) {
    console.error("❌ Database connection failed:", err);
  }
})();

app.use('/session', sessionRoute);

app.use("/logout", logoutRoute);


// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});