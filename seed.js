// seed.js
const bcrypt = require("bcryptjs");
const db = require("./db"); // Ensure this points to your actual db connection file

async function insertMany(table, users) {
  // Upsert: insert or update the hash if username exists
  const sql = `
    INSERT INTO ${table} (username, password_hash)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)
  `;
  for (const { username, password } of users) {
    const password_hash = await bcrypt.hash(password, 10);
    await db.execute(sql, [username, password_hash]);
    console.log(`✅ Upserted ${username} in ${table}`);
  }
}

async function seed() {
  try {
    // Admins
    await insertMany("users_admin", [
      { username: "admin1", password: "Passw0rd!" },
      { username: "admin2", password: "Passw0rd!" },
      { username: "admin3", password: "Passw0rd!" },
    ]);

    // Resident Engineers (RE)
    await insertMany(
      "users_re",
      Array.from({ length: 5 }, (_, i) => ({
        username: `re${i + 1}`,
        password: "Passw0rd!",
      }))
    );

    // Assistant Resident Engineers (ARE)
    await insertMany(
      "users_are",
      Array.from({ length: 5 }, (_, i) => ({
        username: `are${i + 1}`,
        password: "Passw0rd!",
      }))
    );

    // Site Agents
    await insertMany(
      "users_siteagent",
      Array.from({ length: 50 }, (_, i) => ({
        username: `sa${i + 1}`,
        password: "Passw0rd!",
      }))
    );

    // Inspectors
    await insertMany(
      "users_inspector",
      Array.from({ length: 10 }, (_, i) => ({
        username: `ins${i + 1}`,
        password: "Passw0rd!",
      }))
    );

    console.log("🎉 Seeding complete.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding users:", err);
    process.exit(1);
  }
}

seed();
