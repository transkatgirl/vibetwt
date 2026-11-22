export const KINDS = ['like', 'retweet', 'reply'];

const KIND_NAMES = {
  like: 'like',
  likes: 'like',
  retweet: 'retweet',
  retweets: 'retweet',
  rt: 'retweet',
  repost: 'retweet',
  reposts: 'retweet',
  reply: 'reply',
  replies: 'reply',
};

// `kinds` is what the 1/2/3 toggles control and always applies. `expr` is the
// rest: a leaf { field, values }, a group { op: 'and' | 'or', items }, or a
// negation { op: 'not', item }.
export const EMPTY_FILTER = Object.freeze({ kinds: KINDS, expr: null });

const POST_HOST = /(?:^|[/.])(?:x|twitter)\.com\//i;

// Twitter's `-word` shorthand. Text like -_- and well-known is still just text.
const DASH_NOT = /^-(?=[\p{L}\p{N}@"(])/u;

export function tweetIdFrom(value) {
  if (POST_HOST.test(value)) return value.match(/\/status(?:es)?\/(\d+)/i)?.[1] ?? null;
  return /^\d+$/.test(value) ? value : null;
}

// Parentheses group only at the edges of a word, so text like foo(bar) or :)
// can still be searched for without quotes.
function tokenize(query) {
  const tokens = [];
  let index = 0;
  let depth = 0;

  while (index < query.length) {
    const char = query[index];
    if (/\s/.test(char)) {
      index++;
    } else if (char === '(') {
      tokens.push({ type: '(' });
      depth++;
      index++;
    } else if (char === ')' && depth > 0) {
      tokens.push({ type: ')' });
      depth--;
      index++;
    } else if (DASH_NOT.test(query.slice(index, index + 3))) {
      tokens.push({ type: 'not' });
      index++;
    } else if (/^not\(/i.test(query.slice(index, index + 4))) {
      tokens.push({ type: 'not' });
      index += 3;
    } else {
      let raw = '';
      let inner = 0;
      let quoted = false;
      while (index < query.length) {
        const next = query[index];
        if (next === '"') {
          quoted = !quoted;
        } else if (!quoted) {
          if (/\s/.test(next)) break;
          if (next === '(') inner++;
          else if (next === ')') {
            if (inner > 0) inner--;
            else if (depth > 0) break;
          }
        }
        raw += next;
        index++;
      }
      if (/^or$/i.test(raw)) tokens.push({ type: 'or' });
      else if (/^and$/i.test(raw)) tokens.push({ type: 'and' });
      else if (/^not$/i.test(raw)) tokens.push({ type: 'not' });
      else if (raw.replaceAll('"', '').trim()) tokens.push({ type: 'word', raw });
    }
  }
  return tokens;
}

const textLeaf = (value) => ({ field: 'text', values: [value.toLowerCase()] });

function parseWord(raw) {
  const token = raw.replaceAll('"', '').trim();
  if (raw.startsWith('"')) return textLeaf(token);

  const colon = token.indexOf(':');
  const field = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
  const value = colon > 0 ? token.slice(colon + 1) : token;
  const parts = value.split(',').filter(Boolean);

  if (field === 'type' || field === 'kind') {
    if (parts.length === 0) throw new Error('type: needs like, retweet, or reply.');
    const kinds = parts.map((name) => {
      const kind = KIND_NAMES[name.toLowerCase()];
      if (!kind) throw new Error(`Unknown type "${name}". Use like, retweet, or reply.`);
      return kind;
    });
    return { field: 'type', values: KINDS.filter((kind) => kinds.includes(kind)) };
  }
  if (field === 'tweet' || field === 'post') {
    const ids = parts.map(tweetIdFrom);
    if (ids.length === 0 || ids.some((id) => !id)) throw new Error('tweet: needs a tweet ID or URL.');
    return { field: 'tweet', values: [...new Set(ids)] };
  }
  if (field === 'from' || field === 'user') {
    const users = parts.map((part) => part.replace(/^@/, '').toLowerCase()).filter(Boolean);
    if (users.length === 0) throw new Error('from: needs a username.');
    return { field: 'from', values: [...new Set(users)] };
  }

  if (POST_HOST.test(token) && tweetIdFrom(token)) return { field: 'tweet', values: [tweetIdFrom(token)] };
  if (/^\d{15,}$/.test(token)) return { field: 'tweet', values: [token] };
  if (/^@\w+$/.test(token)) return { field: 'from', values: [token.slice(1).toLowerCase()] };
  return textLeaf(token);
}

// `type:a OR type:b` is the same as `type:a,b`, which keeps the toggles accurate.
function mergeTypes(items) {
  const types = items.filter((item) => item.field === 'type');
  if (types.length < 2) return items;
  const values = KINDS.filter((kind) => types.some((type) => type.values.includes(kind)));
  return items
    .filter((item) => item === types[0] || item.field !== 'type')
    .map((item) => (item === types[0] ? { field: 'type', values } : item));
}

function group(op, items) {
  const flat = items.flatMap((item) => (item.op === op ? item.items : [item]));
  const merged = op === 'or' ? mergeTypes(flat) : flat;
  return merged.length === 1 ? merged[0] : { op, items: merged };
}

const topLevel = (expr) => (!expr ? [] : expr.op === 'and' ? expr.items : [expr]);

// `NOT type:like` becomes the other types, which keeps the toggles accurate.
function negate(node) {
  if (node.op === 'not') return node.item;
  if (node.field === 'type') {
    const values = KINDS.filter((kind) => !node.values.includes(kind));
    if (values.length === 0) throw new Error('That excludes every type.');
    return { field: 'type', values };
  }
  return { op: 'not', item: node };
}

function finish(expr) {
  let kinds = KINDS;
  const rest = [];
  for (const item of topLevel(expr)) {
    if (item.field === 'type') {
      kinds = kinds.filter((kind) => item.values.includes(kind));
      if (kinds.length === 0) throw new Error("Those types can't both match. Use type:like,reply for either.");
    } else {
      rest.push(item);
    }
  }
  return { kinds, expr: rest.length > 0 ? group('and', rest) : null };
}

// Syntax: words are ANDed, OR means either, NOT or a leading - excludes, and
// parentheses group. NOT binds tightest, then AND, then OR, so `NOT a b OR c`
// means `((NOT a) b) OR c`.
// Fields: type:like,reply tweet:<id or URL> from:@name word "exact phrase"
export function parseFilter(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { ...EMPTY_FILTER };

  let index = 0;
  const peek = () => tokens[index];
  const isOperand = (token) => ['word', '(', 'not'].includes(token?.type);
  const requireOperand = (name) => {
    if (!isOperand(peek())) throw new Error(`${name} needs a filter after it.`);
  };

  function primary() {
    const token = tokens[index++];
    if (token.type === 'word') return parseWord(token.raw);
    if (token.type === 'not') {
      requireOperand('NOT');
      return negate(primary());
    }

    if (peek()?.type === ')') throw new Error('Empty parentheses.');
    if (!peek()) throw new Error('Missing closing ")".');
    const inner = orExpression();
    if (peek()?.type !== ')') throw new Error('Missing closing ")".');
    index++;
    return inner;
  }

  function andExpression() {
    if (!isOperand(peek())) throw new Error(`${peek().type.toUpperCase()} needs a filter before it.`);
    const items = [primary()];
    while (peek()?.type === 'and' || isOperand(peek())) {
      if (peek().type === 'and') {
        index++;
        requireOperand('AND');
      }
      items.push(primary());
    }
    return group('and', items);
  }

  function orExpression() {
    const items = [andExpression()];
    while (peek()?.type === 'or') {
      index++;
      requireOperand('OR');
      items.push(andExpression());
    }
    return group('or', items);
  }

  return finish(orExpression());
}

function formatTerm(term) {
  const needsQuotes = /\s|:|[()]|^@|^-|^\d{15,}$|^(?:or|and|not)$/i.test(term) || POST_HOST.test(term);
  return needsQuotes ? `"${term}"` : term;
}

function formatNode(node, parentOp) {
  if (node.op === 'not') {
    const inner = formatNode(node.item, 'not');
    return node.item.op ? `NOT (${inner})` : `NOT ${inner}`;
  }
  switch (node.field) {
    case 'type': return `type:${node.values.join(',')}`;
    case 'tweet': return `tweet:${node.values.join(',')}`;
    case 'from': return `from:${node.values.map((user) => (/^\d+$/.test(user) ? user : `@${user}`)).join(',')}`;
    case 'text': return formatTerm(node.values[0]);
    default:
  }
  const text = node.items.map((item) => formatNode(item, node.op)).join(node.op === 'or' ? ' OR ' : ' ');
  return node.op === 'or' && parentOp === 'and' ? `(${text})` : text;
}

export function formatFilter(filter) {
  const parts = [];
  if (filter.kinds.length < KINDS.length) parts.push(`type:${filter.kinds.join(',')}`);
  if (filter.expr) parts.push(formatNode(filter.expr, parts.length > 0 ? 'and' : null));
  return parts.join(' ');
}

function matchesNode(node, event) {
  switch (node.op) {
    case 'and': return node.items.every((item) => matchesNode(item, event));
    case 'or': return node.items.some((item) => matchesNode(item, event));
    case 'not': return !matchesNode(node.item, event);
    default:
  }
  switch (node.field) {
    case 'type':
      return node.values.includes(event.kind);
    case 'tweet':
      return node.values.some((id) => id === event.tweetId || id === event.postId || id === event.conversationId);
    case 'from':
      return node.values.some((user) => user === event.actorId || user === event.actorHandle?.toLowerCase());
    default:
      return [event.text, event.tweetText, event.actorHandle]
        .filter(Boolean)
        .join('\n')
        .toLowerCase()
        .includes(node.values[0]);
  }
}

export function matchesFilter(filter, event) {
  if (!filter.kinds.includes(event.kind)) return false;
  return filter.expr ? matchesNode(filter.expr, event) : true;
}

// Keeps at least one type on, since a filter matching nothing looks broken.
export function toggleKind(filter, kind) {
  const kinds = filter.kinds.includes(kind)
    ? filter.kinds.filter((item) => item !== kind)
    : KINDS.filter((item) => item === kind || filter.kinds.includes(item));
  return kinds.length === 0 ? filter : { ...filter, kinds };
}

// Narrows the filter to one value, replacing any top-level filter on that field.
function narrowed(filter, field, value) {
  const kept = topLevel(filter.expr).filter((item) => item.field !== field);
  return { ...filter, expr: group('and', [...kept, { field, values: [value] }]) };
}

export const withTweet = (filter, id) => narrowed(filter, 'tweet', id);
export const withUser = (filter, user) => narrowed(filter, 'from', user);

// Adds a user to the filter's top-level exclusion, creating it if needed.
export function withoutUser(filter, user) {
  const items = topLevel(filter.expr);
  const existing = items.find((item) => item.op === 'not' && item.item.field === 'from');
  if (!existing) {
    return { ...filter, expr: group('and', [...items, negate({ field: 'from', values: [user] })]) };
  }
  const values = [...new Set([...existing.item.values, user])];
  const merged = negate({ field: 'from', values });
  return { ...filter, expr: group('and', items.map((item) => (item === existing ? merged : item))) };
}

// Every username the filter mentions. Numeric values are account IDs already.
export function filterUsernames(filter) {
  const users = new Set();
  const visit = (node) => {
    if (!node) return;
    if (node.op === 'not') visit(node.item);
    else if (node.op) node.items.forEach((item) => visit(item));
    else if (node.field === 'from') {
      node.values.filter((value) => !/^\d+$/.test(value)).forEach((value) => users.add(value));
    }
  };
  visit(filter.expr);
  return [...users];
}
