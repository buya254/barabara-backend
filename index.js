require('dotenv').config();
const express = require('express');
const cors = require('cors');
const loginRoute = require('./routes/loginRoute');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.use('/login', loginRoute);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
