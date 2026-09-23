const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const db = require("./init");

const users = [
  { name: "Spoorthi V", email: "spurthi@fcbizz.com", role: "ADMIN" },
  { name: "Divya Rao", email: "divya.ops@fcbizz.com", role: "OPS" },
  { name: "Lakshmi Devi", email: "lakshmi.queen@fcbizz.com", role: "QUEEN" },
  { name: "Fatima Bee", email: "fatima.queen@fcbizz.com", role: "QUEEN" },
  { name: "Priya Sharma", email: "priya.retail@fcbizz.com", role: "RETAILER" },
  { name: "Kavya Nair", email: "kavya.logistics@fcbizz.com", role: "LOGISTICS" },
];

const PASSWORD = "Password123!";
const passwordHash = bcrypt.hashSync(PASSWORD, 10);

const insert = db.prepare(`
  INSERT OR IGNORE INTO users (id, name, email, password_hash, organization, role)
  VALUES (?, ?, ?, ?, 'FCMCSL', ?)
`);

for (const u of users) {
  insert.run(uuidv4(), u.name, u.email, passwordHash, u.role);
}

console.log(`Seeded ${users.length} users with password: ${PASSWORD}`);
