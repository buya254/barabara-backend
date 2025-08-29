const jwt = require("jsonwebtoken");

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      console.log("✅ Token verified:", decoded);
      next();
    } catch (err) {
      console.error("❌ Invalid token:", err.message);
      return res.status(403).json({ message: "Invalid or expired token" });
    }
  } else {
    console.warn("⚠️ No token provided in Authorization header");
    return res.status(401).json({ message: "No token provided" });
  }
}

module.exports = authenticateJWT;
