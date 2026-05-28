const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: process.env.DB_HOST || "localhost", // Cambio para compatibilizar con Docker
  database: "ziba_dashboard",
  password: "admin123",
  port: 5432
});

module.exports = pool;