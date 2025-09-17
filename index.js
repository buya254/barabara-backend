require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");

const loginRoute = require("./routes/loginRoute");
const logoutRoute = require("./routes/logoutRoute");
const sessionRoute = require("./routes/sessionRoute");
const userRoutes = require("./routes/Users");

const db = require("./db");

const app = express();

// CORS (allow frontend at port 3000)
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true
}));

// Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || "yoursecret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 3600000,           // 1 hour
    secure: false,             // true in production with HTTPS
    httpOnly: true,            // JS on client can't access cookie
    sameSite: "lax"            // 'none' if using secure: true and cross-site
  }
}));

// Log session contents (optional)
app.use((req, res, next) => {
  console.log("💾 Session info:", req.session);
  next();
});

// Mount Routes
app.use("/login", loginRoute);     // POST /login
app.use("/logout", logoutRoute);   // GET /logout (optional)
app.use("/", sessionRoute);        // GET /check-session
app.use("/api", userRoutes);

// Confirm DB Connection Before Starting
(async () => {
  try {
    await db.query("SELECT 1");
    console.log("✅ Database connected successfully");

    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error("❌ Database connection failed:", err);
  }
})();
