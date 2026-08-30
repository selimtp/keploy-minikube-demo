const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.PGHOST || "postgres",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "keploy",
  password: process.env.PGPASSWORD || "keploy",
  database: process.env.PGDATABASE || "keploy",
});

// Express 4 does not catch rejections from async handlers, so a failing query
// would hang the request instead of answering. During replay that looks like
// Keploy timing out rather than the database mock being wrong.
const route = (handler) => (req, res) =>
  handler(req, res).catch((error) => {
    console.error(error);
    res.status(500).json({ error: "internal error" });
  });

const COLUMNS = 'id, title, content, created_at AS "createdAt"';

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get(
  "/notes",
  route(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM notes ORDER BY id`
    );
    res.status(200).json(rows);
  })
);

app.get(
  "/notes/:id",
  route(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM notes WHERE id = $1`,
      [Number(req.params.id)]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.status(200).json(rows[0]);
  })
);

app.post(
  "/notes",
  route(async (req, res) => {
    const { title, content } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    const { rows } = await pool.query(
      `INSERT INTO notes (title, content) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [title, content || ""]
    );
    res.status(201).json(rows[0]);
  })
);

app.delete(
  "/notes/:id",
  route(async (req, res) => {
    const { rowCount } = await pool.query("DELETE FROM notes WHERE id = $1", [
      Number(req.params.id),
    ]);
    if (rowCount === 0) return res.status(404).json({ error: "Not found" });
    res.status(204).send();
  })
);

const PORT = process.env.PORT || 8080;

// The schema statement runs before listen, so it is part of the recorded traffic
// and has to replay from a mock like every other query.
pool
  .query(
    `CREATE TABLE IF NOT EXISTS notes (
       id SERIAL PRIMARY KEY,
       title TEXT NOT NULL,
       content TEXT NOT NULL DEFAULT '',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  )
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Notes API listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialisation failed", error);
    process.exit(1);
  });
