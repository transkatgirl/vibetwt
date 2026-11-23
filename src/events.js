import { decodeEntities, sanitizeText, singleLine } from './text.js';

const list = (value) => (Array.isArray(value) ? value : []);
// A long post carries its full text apart from `text`. X's API reference calls
// that field `note_post`, and its data dictionary `note_tweet`.
export const postText = (post) => (
  decodeEntities(sanitizeText(post?.note_post?.text ?? post?.note_tweet?.text ?? post?.text)) || null
);

export const actorLabel = (handle, id) => (handle ? `@${handle}` : `user ${id}`);

// Identifies one billable event across reconnects, backfill, and the brief
// overlap when subscriptions are renewed.
export function eventKey(event) {
  const payload = event?.payload ?? {};
  const id = payload.id
    ?? (payload.liking_user_id ? `${payload.liking_user_id}:${payload.liked_tweet_id}` : event?.event_uuid);
  return id ? `${event.event_type}:${id}` : null;
}

// Post text and usernames an event happens to carry, for reuse on later events.
export function collectKnown(event) {
  return {
    tweets: list(event?.includes?.tweets)
      .filter((tweet) => tweet?.id && postText(tweet))
      .map((tweet) => ({ id: String(tweet.id), text: postText(tweet) })),
    users: list(event?.includes?.users)
      .filter((user) => user?.id && user.username)
      .map((user) => ({ id: String(user.id), username: singleLine(user.username) })),
  };
}

function refId(payload, type) {
  return list(payload.referenced_tweets).find((ref) => ref?.type === type)?.id ?? null;
}

// Turns an Activity API event into a display-ready notification, or null when
// it is not an interaction from someone else on this account's posts.
export function normalizeEvent(event, myId) {
  const payload = event?.payload;
  if (!payload) return null;
  if (event.filter?.user_id && event.filter.user_id !== myId) return null;

  const known = collectKnown(event);
  const included = (id) => known.tweets.find((tweet) => tweet.id === id)?.text ?? null;
  let details;

  switch (event.event_type) {
    case 'like.create': {
      if (event.filter?.direction === 'outbound') return null;
      const authorId = payload.liked_tweet_author_id ?? payload.tweet_author_id;
      if (authorId && authorId !== myId) return null;
      details = {
        kind: 'like',
        actorId: payload.liking_user_id,
        postId: null,
        tweetId: payload.liked_tweet_id ?? null,
        text: null,
      };
      details.tweetText = included(details.tweetId);
      break;
    }
    case 'post.repost.create': {
      const tweetId = refId(payload, 'retweeted') ?? payload.id ?? null;
      details = {
        kind: 'retweet',
        actorId: payload.author_id,
        postId: payload.id ?? null,
        tweetId,
        text: null,
        tweetText: included(tweetId) ?? (postText(payload)?.replace(/^RT @\w+:\s*/, '') || null),
      };
      break;
    }
    case 'post.reply.create': {
      const tweetId = payload.in_reply_to_tweet_id ?? refId(payload, 'replied_to');
      details = {
        kind: 'reply',
        actorId: payload.author_id,
        postId: payload.id ?? null,
        tweetId,
        conversationId: payload.conversation_id ?? null,
        text: postText(payload),
        tweetText: included(tweetId),
      };
      break;
    }
    default:
      return null;
  }

  if (!details.actorId || details.actorId === myId) return null;
  const rawHandle = known.users.find((user) => user.id === details.actorId)?.username
    ?? (payload.username ? singleLine(payload.username) : null);

  return {
    conversationId: null,
    ...details,
    key: eventKey(event),
    actorHandle: rawHandle,
    actor: actorLabel(rawHandle, details.actorId),
    createdAt: Date.parse(payload.created_at) || Date.now(),
  };
}

// Remembers recent keys so reconnects and backfill do not replay a buzz.
export class Deduper {
  #seen = new Set();
  #limit;

  constructor(limit = 5000) {
    this.#limit = limit;
  }

  isNew(key) {
    if (key === null) return true;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    if (this.#seen.size > this.#limit) this.#seen.delete(this.#seen.values().next().value);
    return true;
  }
}
