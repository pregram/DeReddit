import request from "supertest";
import app from "../src/server.js";
import { fakeAddr, fakeB32, insertUser, insertForum } from "./fixtures.js";

describe("GET /api/forums", () => {
  it("filters by category", async () => {
    const creator = fakeAddr("creator-1");
    await insertUser(creator);
    await insertForum(fakeB32("tech-forum"), creator, { name: "Tech Talk", category: "Technology" });
    await insertForum(fakeB32("art-forum"), creator, { name: "Art Corner", category: "Art" });

    const res = await request(app).get("/api/forums").query({ category: "Technology" });
    expect(res.status).toBe(200);
    expect(res.body.forums).toHaveLength(1);
    expect(res.body.forums[0].name).toBe("Tech Talk");
  });

  it("filters by search substring against forum name (case-insensitive)", async () => {
    const creator = fakeAddr("creator-2");
    await insertUser(creator);
    await insertForum(fakeB32("puppies"), creator, { name: "Puppies Anonymous" });
    await insertForum(fakeB32("kittens"), creator, { name: "Kitten Lovers" });

    const res = await request(app).get("/api/forums").query({ search: "puppi" });
    expect(res.status).toBe(200);
    expect(res.body.forums).toHaveLength(1);
    expect(res.body.forums[0].name).toBe("Puppies Anonymous");
  });

  it("filters by tags (AND / exact match across multiple chips)", async () => {
    const creator = fakeAddr("creator-3");
    await insertUser(creator);
    await insertForum(fakeB32("ai-hw"), creator, { name: "AI + Hardware", tags: ["ai", "hardware"] });
    await insertForum(fakeB32("ai-only"), creator, { name: "AI Only", tags: ["ai"] });

    const res = await request(app).get("/api/forums").query({ tags: "ai,hardware" });
    expect(res.status).toBe(200);
    expect(res.body.forums).toHaveLength(1);
    expect(res.body.forums[0].name).toBe("AI + Hardware");
  });

  it("sorts by members descending when sort=members", async () => {
    const creator = fakeAddr("creator-4");
    await insertUser(creator);
    await insertForum(fakeB32("small"), creator, { name: "Small Forum", memberCount: 2 });
    await insertForum(fakeB32("big"), creator, { name: "Big Forum", memberCount: 500 });

    const res = await request(app).get("/api/forums").query({ sort: "members" });
    expect(res.status).toBe(200);
    expect(res.body.forums.map((f: { name: string }) => f.name)).toEqual(["Big Forum", "Small Forum"]);
  });

  it("paginates with page/limit", async () => {
    const creator = fakeAddr("creator-5");
    await insertUser(creator);
    for (let i = 0; i < 5; i++) {
      await insertForum(fakeB32(`page-forum-${i}`), creator, { name: `Page Forum ${i}`, memberCount: i + 1 });
    }

    const res = await request(app).get("/api/forums").query({ sort: "members", limit: 2, page: 1 });
    expect(res.status).toBe(200);
    expect(res.body.forums).toHaveLength(2);
    expect(res.body.forums[0].name).toBe("Page Forum 4");

    const res2 = await request(app).get("/api/forums").query({ sort: "members", limit: 2, page: 2 });
    expect(res2.body.forums).toHaveLength(2);
    expect(res2.body.forums[0].name).toBe("Page Forum 2");
  });
});

describe("GET /api/forums/tags", () => {
  it("returns distinct tags matching a substring, ordered by usage count", async () => {
    const creator = fakeAddr("creator-6");
    await insertUser(creator);
    await insertForum(fakeB32("f1"), creator, { name: "F1", tags: ["hardware"] });
    await insertForum(fakeB32("f2"), creator, { name: "F2", tags: ["hardware"] });
    await insertForum(fakeB32("f3"), creator, { name: "F3", tags: ["hard-drives"] });

    const res = await request(app).get("/api/forums/tags").query({ q: "hard" });
    expect(res.status).toBe(200);
    expect(res.body.tags[0]).toBe("hardware");
  });
});
