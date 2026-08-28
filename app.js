const express = require("express");
const app = express();
app.use(express.json());

let notes = [];
let nextId = 1;

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/notes", (req, res) => {
  res.status(200).json(notes);
});

app.get("/notes/:id", (req, res) => {
  const note = notes.find((n) => n.id === Number(req.params.id));
  if (!note) return res.status(404).json({ error: "Not found" });
  res.status(200).json(note);
});

app.post("/notes", (req, res) => {
  const { title, content } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const note = {
    id: nextId++,
    title,
    content: content || "",
    createdAt: new Date().toISOString(),
  };
  notes.push(note);
  res.status(201).json(note);
});

app.delete("/notes/:id", (req, res) => {
  const idx = notes.findIndex((n) => n.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  notes.splice(idx, 1);
  res.status(204).send();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Notes API listening on port ${PORT}`);
});