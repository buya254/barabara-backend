const express = require("express");
const cors = require("cors");
const loginRoute = require("./routes/loginRoute");
const session = require('express-session');
const app = express();

app.use(cors());
app.use(express.json());
app.use(session({
  secret: 'mamaaIsSecure', // 🔐 keep this secret in .env for production
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 60 * 60 * 1000 // 🕐 1 hour session (in milliseconds)
  }
}));


app.use("/login", loginRoute);

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
