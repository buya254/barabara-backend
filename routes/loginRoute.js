const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const prisma = require("../prismaClient");

router.post("/", async (req, res) => {
  const { username, password } = req.body;
  console.log("🥳 Login attempt:", username);

  try {
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user) return res.status(401).json({ message: "User not found" });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ message: "Invalid password" });

    return res.status(200).json({
      user: {
        username: user.username,
        role: user.role,
      },
    });

  } catch (err) {
    console.error("❌ Server error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
