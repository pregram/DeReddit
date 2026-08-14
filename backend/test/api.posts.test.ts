import request from "supertest";
import app from "../src/server.js";
import { fakeAddr, fakeB32, insertUser, insertForum, insertPost } from "./fixtures.js";

describe("GET /api/forums/:forumKey/posts - UNCONFIGURED_FILTER", () => {
  it("excludes an unconfigured Poll post (poll_option_count still NULL) from the feed", async () => {
    const author = fakeAddr("author-1");
    const forumKey = fakeB32("forum-unconf");
    await insertUser(author);
    await insertForum(forumKey, author);
    await insertPost(1, forumKey, author, { postType: "Poll", pollOptionCount: null });
    await insertPost(2, forumKey, author, { postType: "Standard" });

    const res = await request(app).get(`/api/forums/${forumKey}/posts`);
    expect(res.status).toBe(200);
    const ids = res.body.posts.map((p: { post_id: string }) => p.post_id);
    expect(ids).toEqual(["2"]);
  });

  it("includes a configured Poll post (poll_option_count > 0) in the feed", async () => {
    const author = fakeAddr("author-2");
    const forumKey = fakeB32("forum-conf");
    await insertUser(author);
    await insertForum(forumKey, author);
    await insertPost(1, forumKey, author, { postType: "Poll", pollOptionCount: 2 });

    const res = await request(app).get(`/api/forums/${forumKey}/posts`);
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(1);
  });

  it("still allows an unconfigured post to be reached directly by ID", async () => {
    const author = fakeAddr("author-3");
    const forumKey = fakeB32("forum-direct");
    await insertUser(author);
    await insertForum(forumKey, author);
    await insertPost(7, forumKey, author, { postType: "Crowdfund", cfTargetGoal: null });

    const res = await request(app).get("/api/posts/7");
    expect(res.status).toBe(200);
    expect(res.body.post.post_id).toBe("7");
  });
});

describe("GET /api/posts/:postId and forum feed - TimeCapsule visibility", () => {
  it("nulls title/body/media for a non-author viewer before visible_after", async () => {
    const author = fakeAddr("author-4");
    const viewer = fakeAddr("viewer-1");
    const forumKey = fakeB32("forum-tc");
    await insertUser(author);
    await insertUser(viewer);
    await insertForum(forumKey, author);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await insertPost(10, forumKey, author, {
      postType: "TimeCapsule",
      title: "Secret",
      body: "Hidden body",
      visibleAfter: future,
    });

    const res = await request(app).get("/api/posts/10").query({ userWallet: viewer });
    expect(res.status).toBe(200);
    expect(res.body.post.title).toBeNull();
    expect(res.body.post.body).toBeNull();
  });

  it("still shows title/body to the author before visible_after", async () => {
    const author = fakeAddr("author-5");
    const forumKey = fakeB32("forum-tc-2");
    await insertUser(author);
    await insertForum(forumKey, author);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await insertPost(11, forumKey, author, {
      postType: "TimeCapsule",
      title: "Secret",
      body: "Hidden body",
      visibleAfter: future,
    });

    const res = await request(app).get("/api/posts/11").query({ userWallet: author });
    expect(res.status).toBe(200);
    expect(res.body.post.title).toBe("Secret");
    expect(res.body.post.body).toBe("Hidden body");
  });

  it("reveals title/body to everyone once visible_after has passed", async () => {
    const author = fakeAddr("author-6");
    const viewer = fakeAddr("viewer-2");
    const forumKey = fakeB32("forum-tc-3");
    await insertUser(author);
    await insertUser(viewer);
    await insertForum(forumKey, author);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await insertPost(12, forumKey, author, {
      postType: "TimeCapsule",
      title: "Revealed",
      body: "Now visible",
      visibleAfter: past,
    });

    const res = await request(app).get("/api/posts/12").query({ userWallet: viewer });
    expect(res.status).toBe(200);
    expect(res.body.post.title).toBe("Revealed");
    expect(res.body.post.body).toBe("Now visible");
  });

  it("nulls title in the forum feed the same way for a non-author viewer", async () => {
    const author = fakeAddr("author-7");
    const viewer = fakeAddr("viewer-3");
    const forumKey = fakeB32("forum-tc-4");
    await insertUser(author);
    await insertUser(viewer);
    await insertForum(forumKey, author);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await insertPost(13, forumKey, author, {
      postType: "TimeCapsule",
      title: "Secret Feed Post",
      visibleAfter: future,
    });

    const res = await request(app).get(`/api/forums/${forumKey}/posts`).query({ userWallet: viewer });
    expect(res.status).toBe(200);
    expect(res.body.posts[0].title).toBeNull();
  });
});

describe("GET /api/forums/:forumKey/posts - ordering, filtering, pagination", () => {
  it("sorts by top (upvotes desc)", async () => {
    const author = fakeAddr("author-8");
    const forumKey = fakeB32("forum-top");
    await insertUser(author);
    await insertForum(forumKey, author);
    await insertPost(20, forumKey, author, { title: "Low", upvotes: 1 });
    await insertPost(21, forumKey, author, { title: "High", upvotes: 99 });

    const res = await request(app).get(`/api/forums/${forumKey}/posts`).query({ sort: "top" });
    expect(res.body.posts.map((p: { title: string }) => p.title)).toEqual(["High", "Low"]);
  });

  it("filters by post type", async () => {
    const author = fakeAddr("author-9");
    const forumKey = fakeB32("forum-type-filter");
    await insertUser(author);
    await insertForum(forumKey, author);
    await insertPost(30, forumKey, author, { postType: "Standard", title: "Standard Post" });
    await insertPost(31, forumKey, author, { postType: "Poll", pollOptionCount: 2, title: "Poll Post" });

    const res = await request(app).get(`/api/forums/${forumKey}/posts`).query({ type: "Poll" });
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.posts[0].title).toBe("Poll Post");
  });

  it("paginates the feed with page/limit", async () => {
    const author = fakeAddr("author-10");
    const forumKey = fakeB32("forum-paginate");
    await insertUser(author);
    await insertForum(forumKey, author);
    for (let i = 0; i < 5; i++) {
      await insertPost(40 + i, forumKey, author, { title: `Post ${i}`, upvotes: i });
    }

    const res = await request(app).get(`/api/forums/${forumKey}/posts`).query({ sort: "top", limit: 2, page: 2 });
    expect(res.body.posts).toHaveLength(2);
    expect(res.body.posts.map((p: { title: string }) => p.title)).toEqual(["Post 2", "Post 1"]);
  });
});
