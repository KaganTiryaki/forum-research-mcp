import { assessDiscoveryCandidate, assessRelevance } from "./relevance.js";

export interface ReadFocus {
  query: string;
  variants: string[];
}

export interface DiscoursePost {
  postNumber?: number;
  username?: string;
  createdAt?: string;
  text: string;
}

export interface DiscourseTopic {
  totalPosts?: number;
  title: string;
  publishedAt?: string;
  posts: DiscoursePost[];
}

function decodeHtml(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromCooked(input: string): string {
  return decodeHtml(input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

export function discourseTopicJsonUrl(target: URL): URL {
  if (!/^\/t\/[^/]+\/\d+\/?$/i.test(target.pathname)) {
    throw new Error("Discourse topic path is not valid");
  }
  const json = new URL(target);
  json.pathname = `${target.pathname.replace(/\/$/, "")}.json`;
  return json;
}

export function parseDiscourseTopic(input: string): DiscourseTopic {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    throw new Error("Discourse topic response was not valid JSON");
  }
  if (!payload || typeof payload !== "object") throw new Error("Discourse topic response was malformed");
  const value = payload as {
    title?: unknown;
    created_at?: unknown;
    posts_count?: number;
    post_stream?: { posts?: Array<{ post_number?: number; username?: unknown; created_at?: unknown; cooked?: unknown }> };
  };
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const posts = (value.post_stream?.posts ?? []).slice(0, 60).flatMap((post) => {
    if (typeof post.cooked !== "string") return [];
    const text = textFromCooked(post.cooked);
    if (!text) return [];
    return [{
      postNumber: post.post_number,
      username: typeof post.username === "string" ? post.username : undefined,
      createdAt: typeof post.created_at === "string" ? post.created_at : undefined,
      text,
    }];
  });
  if (!title || !posts.length) throw new Error("Discourse topic response contained no readable posts");
  return {
    totalPosts: value.posts_count,
    title,
    publishedAt: typeof value.created_at === "string" ? value.created_at : posts[0]?.createdAt,
    posts,
  };
}

export function discourseExcerpt(topic: DiscourseTopic, focus?: ReadFocus, maxChars = 1_200): string {
  const ranked = topic.posts.map((post, index) => {
    if (!focus) return { post, index, score: Math.max(1, 3 - index) };
    const strict = assessRelevance({ ...focus, title: topic.title, text: post.text });
    const candidate = assessDiscoveryCandidate({
      ...focus,
      title: topic.title,
      text: post.text,
      domainTags: ["maritime"],
    });
    return { post, index, score: strict.accepted ? 100 + strict.score : candidate.accepted ? 10 + candidate.score : 0 };
  });
  const selected = ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .sort((left, right) => left.index - right.index)
    .map(({ post }) => post.text);
  return selected.join(" ").slice(0, maxChars);
}
