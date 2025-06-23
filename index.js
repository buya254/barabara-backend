const express = require("express");
const cors = require("cors");
const loginRoute = require("./routes/loginRoute");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/login", loginRoute);

app.listen(5000, () => {
  console.log("🚀 Server running on port 5000");
});
