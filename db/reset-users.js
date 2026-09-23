const db = require("./init");
db.prepare("DELETE FROM users").run();
console.log("All users cleared.");